import { Router, Request, Response } from 'express';
import { prisma } from 'fattips-database';
import {
  WalletService,
  TransactionService,
  BalanceService,
  PriceService,
  TOKEN_MINTS,
} from 'fattips-solana';
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

interface RainRequest {
  creatorDiscordId: string;
  amount: number;
  token: 'SOL' | 'USDC' | 'USDT';
  winners: string[];
  amountType?: 'token' | 'usd';
}

router.use(requireAuth);

router.post('/create', async (req: AuthenticatedRequest, res: Response) => {
  const {
    creatorDiscordId,
    amount,
    token,
    winners,
    amountType = 'token',
  } = req.body as RainRequest;

  if (creatorDiscordId !== req.discordId) {
    res.status(403).json({ error: 'API key can only rain from its own wallet' });
    return;
  }

  try {
    if (!winners || winners.length === 0) {
      res.status(400).json({ error: 'At least one winner required' });
      return;
    }

    if (winners.length > 25) {
      res.status(400).json({ error: 'Maximum 25 winners per rain' });
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

    const amountPerUser = amountToken / winners.length;

    if (amountPerUser <= 0.000001) {
      res.status(400).json({ error: 'Amount too small to split among winners' });
      return;
    }

    const recipientWallets = [];
    const newWallets: { id: string; key: string }[] = [];

    for (const winnerId of winners) {
      let recipient = await prisma.user.findUnique({
        where: { discordId: winnerId },
      });

      if (!recipient) {
        const wallet = await walletService.createEncryptedWallet();
        recipient = await prisma.user.create({
          data: {
            discordId: winnerId,
            walletPubkey: wallet.publicKey,
            encryptedPrivkey: wallet.encryptedPrivateKey,
            keySalt: wallet.keySalt,
            encryptedMnemonic: wallet.encryptedMnemonic,
            mnemonicSalt: wallet.mnemonicSalt,
            seedDelivered: false,
          },
        });
        newWallets.push({ id: winnerId, key: wallet.privateKeyBase58 });
      }
      recipientWallets.push(recipient);
    }

    const balances = await balanceService.getBalances(creator.walletPubkey);
    const feeBuffer = 0.00002;
    const rentReserve = 0.00089088;

    if (token === 'SOL') {
      const required = amountToken + feeBuffer + rentReserve;
      if (balances.sol + 0.000001 < required) {
        res.status(400).json({ error: 'Insufficient SOL balance' });
        return;
      }
    } else {
      const currentBal = token === 'USDC' ? balances.usdc : balances.usdt;
      if (currentBal < amountToken) {
        res.status(400).json({ error: `Insufficient ${token} balance` });
        return;
      }
      if (balances.sol < feeBuffer) {
        res.status(400).json({ error: 'Insufficient SOL for gas fees' });
        return;
      }
    }

    const creatorKeypair = await walletService.getKeypair(
      creator.encryptedPrivkey,
      creator.keySalt
    );
    const transfers = recipientWallets.map((r) => ({
      recipient: r.walletPubkey,
      amount: amountPerUser,
    }));

    const signature = await transactionService.batchTransfer(creatorKeypair, transfers, tokenMint);

    const transactions = [];
    for (let i = 0; i < recipientWallets.length; i++) {
      const r = recipientWallets[i];
      const batchSignature = recipientWallets.length > 1 ? `${signature}:${i}` : signature;
      const usdPerUser = usdValue / recipientWallets.length;

      await prisma.transaction.create({
        data: {
          signature: batchSignature,
          fromId: creator.discordId,
          toId: r.discordId,
          amountUsd: usdPerUser,
          amountToken: amountPerUser,
          tokenMint,
          usdRate: usdPerUser > 0 ? usdPerUser / amountPerUser : 0,
          txType: 'TIP',
          status: 'CONFIRMED',
        },
      });

      transactions.push({
        discordId: r.discordId,
        signature: batchSignature,
        amountToken: amountPerUser,
        amountUsd: usdPerUser,
      });
    }

    res.json({
      success: true,
      signature,
      creator: creatorDiscordId,
      winners: transactions,
      totalAmountToken: amountToken,
      totalAmountUsd: usdValue,
      token,
      amountPerUser,
      winnersCount: winners.length,
      newWallets: newWallets.length > 0 ? newWallets : undefined,
      solscanUrl: `https://solscan.io/tx/${signature}`,
    });
  } catch (error) {
    console.error('Error creating rain:', error);
    res.status(500).json({ error: 'Failed to create rain' });
  }
});

export default router;
