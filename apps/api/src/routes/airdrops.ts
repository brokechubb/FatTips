import { Router, Request, Response } from 'express';
import { prisma } from 'fattips-database';
import {
  WalletService,
  TransactionService,
  BalanceService,
  PriceService,
  TOKEN_MINTS,
} from 'fattips-solana';
import { eventBus, EVENTS } from '../services/event-bus';
import { requireAuth } from '../middleware/auth';

const router: Router = Router();

const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);

interface AuthenticatedRequest extends Request {
  discordId?: string;
}

async function getTokenMint(token: string): Promise<string> {
  return TOKEN_MINTS[token as keyof typeof TOKEN_MINTS];
}

function parseDuration(str: string): number | null {
  const match = str.trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (val < 0) return null;
  let multiplier = 1000;
  if (unit === 'm') multiplier *= 60;
  if (unit === 'h') multiplier *= 60 * 60;
  if (unit === 'd') multiplier *= 24 * 60 * 60;
  if (unit === 'w') multiplier *= 7 * 24 * 60 * 60;
  return Math.floor(val * multiplier);
}

interface CreateAirdropRequest {
  creatorDiscordId: string;
  amount: number;
  token: 'SOL' | 'USDC' | 'USDT';
  duration: string;
  maxWinners?: number;
  amountType?: 'token' | 'usd';
  channelId?: string; // Discord channel ID to post the airdrop message
}

router.use(requireAuth);

router.post('/create', async (req: AuthenticatedRequest, res: Response) => {
  const {
    creatorDiscordId,
    amount,
    token,
    duration,
    maxWinners,
    amountType = 'token',
    channelId,
  } = req.body as CreateAirdropRequest;

  if (creatorDiscordId !== req.discordId) {
    res.status(403).json({ error: 'API key can only create airdrops from its own wallet' });
    return;
  }

  try {
    const durationMs = parseDuration(duration);
    if (!durationMs || durationMs < 10000) {
      res.status(400).json({ error: 'Invalid duration. Must be at least 10 seconds.' });
      return;
    }

    const creator = await prisma.user.findUnique({
      where: { discordId: creatorDiscordId },
    });

    if (!creator) {
      res.status(404).json({ error: 'Creator wallet not found' });
      return;
    }

    const tokenMint = await getTokenMint(token);
    let amountToken = amount;
    let usdValue = 0;

    if (amountType === 'usd') {
      const conversion = await priceService.convertUsdToToken(amount, tokenMint, token);
      if (!conversion) {
        res.status(400).json({ error: 'Failed to fetch price' });
        return;
      }
      amountToken = conversion.amountToken;
      usdValue = amount;
    } else {
      const price = await priceService.getTokenPrice(tokenMint);
      usdValue = price ? amount * price.price : 0;
    }

    // Validate amount
    if (amountToken <= 0) {
      res.status(400).json({ error: 'Amount must be greater than 0' });
      return;
    }

    const ephemeralWallet = await walletService.createEncryptedWallet();

    // Fix #13: Create DB record FIRST to persist the key
    // If we crash during funding, we at least have the key to recover funds
    const expiresAt = new Date(Date.now() + durationMs);
    const airdrop = await prisma.airdrop.create({
      data: {
        walletPubkey: ephemeralWallet.publicKey,
        encryptedPrivkey: ephemeralWallet.encryptedPrivateKey,
        keySalt: ephemeralWallet.keySalt,
        creatorId: creator.discordId,
        amountTotal: amountToken,
        tokenMint,
        maxParticipants: maxWinners || null,
        expiresAt,
        channelId: channelId || 'api',
        status: 'ACTIVE', // Will be set to FAILED if funding fails
      },
    });

    // Calculate gas buffer based on max winners to account for rent exemption
    // Each new winner wallet needs 0.00089 SOL rent exemption + 0.000005 SOL tx fee
    const winnerCount = maxWinners || 100; // Default to 100 if not specified
    const RENT_EXEMPTION = 0.00089; // Minimum balance for rent exemption
    const TX_FEE = 0.000005; // Per transaction fee
    const GAS_BUFFER = 0.003 + winnerCount * (RENT_EXEMPTION + TX_FEE);

    let fundingAmountSol = 0;
    let fundingAmountToken = 0;

    if (token === 'SOL') {
      fundingAmountSol = amountToken + GAS_BUFFER;
    } else {
      fundingAmountSol = GAS_BUFFER;
      fundingAmountToken = amountToken;
    }

    const creatorBalances = await balanceService.getBalances(creator.walletPubkey);
    if (creatorBalances.sol < fundingAmountSol) {
      await prisma.airdrop.update({ where: { id: airdrop.id }, data: { status: 'FAILED', amountClaimed: 0 } });
      res.status(400).json({ error: 'Insufficient SOL for gas' });
      return;
    }
    if (fundingAmountToken > 0) {
      const tokenBal = token === 'USDC' ? creatorBalances.usdc : creatorBalances.usdt;
      if (tokenBal < fundingAmountToken) {
        await prisma.airdrop.update({ where: { id: airdrop.id }, data: { status: 'FAILED', amountClaimed: 0 } });
        res.status(400).json({ error: `Insufficient ${token}` });
        return;
      }
    }

    const creatorKeypair = await walletService.getKeypair(
      creator.encryptedPrivkey,
      creator.keySalt
    );

    let solSig: string | undefined;
    let tokenSig: string | undefined;

    try {
      if (fundingAmountSol > 0) {
        const solToSend = token === 'SOL' ? amountToken + GAS_BUFFER : GAS_BUFFER;
        solSig = await transactionService.transfer(
          creatorKeypair,
          ephemeralWallet.publicKey,
          solToSend,
          TOKEN_MINTS.SOL
        );
        console.log(`[AIRDROP] SOL funding transaction: ${solSig}`);
      }

      if (fundingAmountToken > 0) {
        tokenSig = await transactionService.transfer(
          creatorKeypair,
          ephemeralWallet.publicKey,
          fundingAmountToken,
          tokenMint
        );
        console.log(`[AIRDROP] Token funding transaction: ${tokenSig}`);
      }
    } catch (fundError) {
      console.error('Funding failed:', fundError);
      await prisma.airdrop.update({ where: { id: airdrop.id }, data: { status: 'FAILED', amountClaimed: 0 } });
      res.status(500).json({ error: 'Failed to fund airdrop wallet' });
      return;
    }

    // Wait a moment for transactions to be fully processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify the ephemeral wallet was funded
    const walletBalances = await balanceService.getBalances(ephemeralWallet.publicKey);
    if (token === 'SOL') {
      if (walletBalances.sol < amountToken) {
        // Don't fail here, just log warning. The key is safe in DB.
        console.warn(`[AIRDROP] Wallet ${ephemeralWallet.publicKey} might not be fully funded yet (SOL=${walletBalances.sol})`);
      }
    }

    // Publish airdrop created event for Discord bot to post message
    if (channelId) {
      await eventBus.publish(EVENTS.AIRDROP_CREATED, {
        airdropId: airdrop.id,
        channelId,
        creatorId: creator.discordId,
        creatorUsername: '', // Username will be fetched by the bot
        potSize: amountToken,
        token,
        totalUsd: usdValue,
        expiresAt: expiresAt.toISOString(),
        maxWinners: maxWinners || null,
      });
    }

    res.json({
      success: true,
      airdropId: airdrop.id,
      potSize: amountToken,
      token,
      totalUsd: usdValue,
      expiresAt: expiresAt.toISOString(),
      maxWinners: maxWinners || 'unlimited',
      ephemeralWallet: ephemeralWallet.publicKey,
    });
  } catch (error) {
    console.error('Error creating airdrop:', error);
    res.status(500).json({ error: 'Failed to create airdrop' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const airdrop = await prisma.airdrop.findUnique({
      where: { id },
      include: {
        creator: {
          select: { discordId: true },
        },
        participants: {
          include: {
            user: {
              select: { discordId: true },
            },
          },
        },
      },
    });

    if (!airdrop) {
      res.status(404).json({ error: 'Airdrop not found' });
      return;
    }

    res.json({
      id: airdrop.id,
      creatorId: airdrop.creatorId,
      potSize: Number(airdrop.amountTotal),
      tokenMint: airdrop.tokenMint,
      participantCount: airdrop.participantCount,
      maxParticipants: airdrop.maxParticipants,
      status: airdrop.status,
      expiresAt: airdrop.expiresAt.toISOString(),
      createdAt: airdrop.createdAt.toISOString(),
      participants: airdrop.participants.map((p: any) => ({
        discordId: p.user.discordId,
        status: p.status,
        shareAmount: Number(p.shareAmount),
      })),
    });
  } catch (error) {
    console.error('Error fetching airdrop:', error);
    res.status(500).json({ error: 'Failed to fetch airdrop' });
  }
});

router.post('/:id/claim', async (req, res) => {
  const { id } = req.params;
  const { discordId } = req.body;

  try {
    const airdrop = await prisma.airdrop.findUnique({
      where: { id },
    });

    if (!airdrop) {
      res.status(404).json({ error: 'Airdrop not found' });
      return;
    }

    if (new Date() > airdrop.expiresAt) {
      res.status(400).json({ error: 'Airdrop has expired' });
      return;
    }

    if (airdrop.status !== 'ACTIVE') {
      res.status(400).json({ error: `Airdrop is ${airdrop.status.toLowerCase()}` });
      return;
    }

    if (airdrop.maxParticipants && airdrop.participantCount >= airdrop.maxParticipants) {
      res.status(400).json({ error: 'Max participants reached' });
      return;
    }

    const existingParticipant = await prisma.airdropParticipant.findUnique({
      where: {
        airdropId_userId: {
          airdropId: id,
          userId: discordId,
        },
      },
    });

    if (existingParticipant) {
      res.status(400).json({ error: 'Already claimed' });
      return;
    }

    // Ensure user exists (create wallet if needed)
    let recipient = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!recipient) {
      const wallet = await walletService.createEncryptedWallet();
      recipient = await prisma.user.create({
        data: {
          discordId,
          walletPubkey: wallet.publicKey,
          encryptedPrivkey: wallet.encryptedPrivateKey,
          keySalt: wallet.keySalt,
          encryptedMnemonic: wallet.encryptedMnemonic,
          mnemonicSalt: wallet.mnemonicSalt,
          seedDelivered: false,
        },
      });
    }

    // Register as participant only — funds are distributed at settlement
    // This matches the bot's behavior and prevents early claimants from draining the pot
    try {
      await prisma.airdropParticipant.create({
        data: {
          airdropId: id,
          userId: discordId,
          shareAmount: 0, // Calculated at settlement
          status: 'PENDING',
        },
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        res.status(400).json({ error: 'Already claimed' });
        return;
      }
      throw error;
    }

    // Atomically increment participant count
    const updatedAirdrop = await prisma.airdrop.update({
      where: { id },
      data: { participantCount: { increment: 1 } },
    });

    res.json({
      success: true,
      airdropId: id,
      claimant: discordId,
      participantCount: updatedAirdrop.participantCount,
      maxParticipants: updatedAirdrop.maxParticipants,
      status: 'PENDING',
      message: 'Claimed successfully. Funds will be distributed when the airdrop settles.',
    });
  } catch (error) {
    console.error('Error claiming airdrop:', error);
    res.status(500).json({ error: 'Failed to claim airdrop' });
  }
});

router.get('/', async (req, res) => {
  const { status, limit = 10, offset = 0 } = req.query;

  try {
    const airdrops = await prisma.airdrop.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      skip: Number(offset),
      include: {
        creator: {
          select: { discordId: true },
        },
      },
    });

    res.json({
      airdrops: airdrops.map((a: any) => ({
        id: a.id,
        creatorId: a.creatorId,
        potSize: Number(a.amountTotal),
        tokenMint: a.tokenMint,
        participantCount: a.participantCount,
        maxParticipants: a.maxParticipants,
        status: a.status,
        expiresAt: a.expiresAt.toISOString(),
      })),
      total: airdrops.length,
    });
  } catch (error) {
    console.error('Error listing airdrops:', error);
    res.status(500).json({ error: 'Failed to list airdrops' });
  }
});

export default router;
