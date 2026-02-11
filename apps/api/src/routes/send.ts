import { Router } from 'express';
import { prisma } from 'fattips-database';
import {
  WalletService,
  TransactionService,
  BalanceService,
  PriceService,
  TOKEN_MINTS,
} from 'fattips-solana';

const router: Router = Router();

const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);

interface SendRequest {
  fromDiscordId: string;
  toDiscordId: string;
  amount: number;
  token: 'SOL' | 'USDC' | 'USDT';
  amountType?: 'token' | 'usd';
}

interface BatchSendRequest {
  fromDiscordId: string;
  recipients: { discordId: string; percentage?: number }[];
  totalAmount: number;
  token: 'SOL' | 'USDC' | 'USDT';
  amountType?: 'token' | 'usd';
}

async function getTokenMint(token: string): Promise<string> {
  return TOKEN_MINTS[token as keyof typeof TOKEN_MINTS];
}

async function calculateAmounts(
  amount: number,
  token: string,
  amountType: 'token' | 'usd',
  isMax: boolean
): Promise<{ amountToken: number; usdValue: number; tokenMint: string }> {
  const tokenMint = await getTokenMint(token);

  if (isMax) {
    return { amountToken: amount, usdValue: 0, tokenMint };
  }

  if (amountType === 'usd') {
    const conversion = await priceService.convertUsdToToken(amount, tokenMint, token);
    if (!conversion) {
      throw new Error('Failed to convert USD to token');
    }
    return {
      amountToken: conversion.amountToken,
      usdValue: amount,
      tokenMint,
    };
  }

  const price = await priceService.getTokenPrice(tokenMint);
  const usdValue = price ? amount * price.price : 0;

  return { amountToken: amount, usdValue, tokenMint };
}

router.post('/tip', async (req, res) => {
  const {
    fromDiscordId,
    toDiscordId,
    amount,
    token,
    amountType = 'token',
  } = req.body as SendRequest;

  try {
    const sender = await prisma.user.findUnique({
      where: { discordId: fromDiscordId },
    });

    if (!sender) {
      res.status(404).json({ error: 'Sender wallet not found' });
      return;
    }

    let recipient = await prisma.user.findUnique({
      where: { discordId: toDiscordId },
    });

    if (!recipient) {
      const wallet = await walletService.createEncryptedWallet();
      recipient = await prisma.user.create({
        data: {
          discordId: toDiscordId,
          walletPubkey: wallet.publicKey,
          encryptedPrivkey: wallet.encryptedPrivateKey,
          keySalt: wallet.keySalt,
          encryptedMnemonic: wallet.encryptedMnemonic,
          mnemonicSalt: wallet.mnemonicSalt,
          seedDelivered: false,
        },
      });
    }

    const { amountToken, usdValue, tokenMint } = await calculateAmounts(
      amount,
      token,
      amountType,
      false
    );

    const balances = await balanceService.getBalances(sender.walletPubkey);
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

    const senderKeypair = await walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
    const signature = await transactionService.transfer(
      senderKeypair,
      recipient.walletPubkey,
      amountToken,
      tokenMint
    );

    await prisma.transaction.create({
      data: {
        signature,
        fromId: sender.discordId,
        toId: recipient.discordId,
        amountUsd: usdValue,
        amountToken,
        tokenMint,
        usdRate: usdValue > 0 ? usdValue / amountToken : 0,
        txType: 'TIP',
        status: 'CONFIRMED',
      },
    });

    res.json({
      success: true,
      signature,
      from: sender.discordId,
      to: recipient.discordId,
      amountToken,
      amountUsd: usdValue,
      token,
      solscanUrl: `https://solscan.io/tx/${signature}`,
    });
  } catch (error) {
    console.error('Error sending tip:', error);
    res.status(500).json({ error: 'Failed to send tip' });
  }
});

router.post('/batch-tip', async (req, res) => {
  const {
    fromDiscordId,
    recipients,
    totalAmount,
    token,
    amountType = 'token',
  } = req.body as BatchSendRequest;

  try {
    const sender = await prisma.user.findUnique({
      where: { discordId: fromDiscordId },
    });

    if (!sender) {
      res.status(404).json({ error: 'Sender wallet not found' });
      return;
    }

    const recipientWallets = [];
    const newWallets: { id: string; key: string }[] = [];

    for (const r of recipients) {
      let recipient = await prisma.user.findUnique({
        where: { discordId: r.discordId },
      });

      if (!recipient) {
        const wallet = await walletService.createEncryptedWallet();
        recipient = await prisma.user.create({
          data: {
            discordId: r.discordId,
            walletPubkey: wallet.publicKey,
            encryptedPrivkey: wallet.encryptedPrivateKey,
            keySalt: wallet.keySalt,
            encryptedMnemonic: wallet.encryptedMnemonic,
            mnemonicSalt: wallet.mnemonicSalt,
            seedDelivered: false,
          },
        });
        newWallets.push({ id: r.discordId, key: wallet.privateKeyBase58 });
      }
      recipientWallets.push({ user: recipient, percentage: r.percentage });
    }

    const { amountToken, usdValue, tokenMint } = await calculateAmounts(
      totalAmount,
      token,
      amountType,
      false
    );
    const amountPerUser = amountToken / recipientWallets.length;

    const balances = await balanceService.getBalances(sender.walletPubkey);
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

    const senderKeypair = await walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
    const transfers = recipientWallets.map((r) => ({
      recipient: r.user.walletPubkey,
      amount: amountPerUser,
    }));

    const signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint);

    const transactions = [];
    for (let i = 0; i < recipientWallets.length; i++) {
      const r = recipientWallets[i];
      const batchSignature = recipientWallets.length > 1 ? `${signature}:${i}` : signature;
      const usdPerUser = usdValue / recipientWallets.length;

      await prisma.transaction.create({
        data: {
          signature: batchSignature,
          fromId: sender.discordId,
          toId: r.user.discordId,
          amountUsd: usdPerUser,
          amountToken: amountPerUser,
          tokenMint,
          usdRate: usdPerUser > 0 ? usdPerUser / amountPerUser : 0,
          txType: 'TIP',
          status: 'CONFIRMED',
        },
      });

      transactions.push({
        to: r.user.discordId,
        signature: batchSignature,
        amountToken: amountPerUser,
        amountUsd: usdPerUser,
      });
    }

    res.json({
      success: true,
      signature,
      from: sender.discordId,
      recipients: transactions,
      totalAmountToken: amountToken,
      totalAmountUsd: usdValue,
      token,
      solscanUrl: `https://solscan.io/tx/${signature}`,
      newWallets: newWallets.length > 0 ? newWallets : undefined,
    });
  } catch (error) {
    console.error('Error sending batch tip:', error);
    res.status(500).json({ error: 'Failed to send batch tip' });
  }
});

router.post('/withdraw', async (req, res) => {
  const { discordId, destinationAddress, amount, token } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!user) {
      res.status(404).json({ error: 'User wallet not found' });
      return;
    }

    const tokenMint = await getTokenMint(token);
    const { amountToken, usdValue } = await calculateAmounts(amount || 0, token, 'token', !amount);

    const balances = await balanceService.getBalances(user.walletPubkey);
    const feeBuffer = 0.00002;

    let amountToSend = amountToken;
    if (token === 'SOL') {
      if (!amount) {
        const maxPossible = Math.max(0, balances.sol - feeBuffer - 0.00089088);
        amountToSend = maxPossible;
      }
    }

    const userKeypair = await walletService.getKeypair(user.encryptedPrivkey, user.keySalt);
    const signature = await transactionService.transfer(
      userKeypair,
      destinationAddress,
      amountToSend,
      tokenMint
    );

    await prisma.transaction.create({
      data: {
        signature,
        fromId: user.discordId,
        fromAddress: user.walletPubkey,
        toAddress: destinationAddress,
        amountUsd: usdValue,
        amountToken: amountToSend,
        tokenMint,
        usdRate: usdValue > 0 ? usdValue / amountToSend : 0,
        txType: 'WITHDRAWAL',
        status: 'CONFIRMED',
      },
    });

    res.json({
      success: true,
      signature,
      from: user.walletPubkey,
      to: destinationAddress,
      amountToken: amountToSend,
      amountUsd: usdValue,
      token,
      solscanUrl: `https://solscan.io/tx/${signature}`,
    });
  } catch (error) {
    console.error('Error withdrawing:', error);
    res.status(500).json({ error: 'Failed to withdraw' });
  }
});

export default router;
