#!/usr/bin/env node
/**
 * Recovery script for stuck airdrop funds
 *
 * When an airdrop creation fails during the verification step,
 * the ephemeral wallet's encrypted private key is lost (never saved to DB).
 * This script helps identify and recover such funds.
 *
 * Usage: node scripts/recover-stuck-airdrop-funds.js <creator-wallet-address>
 */

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
} = require('@solana/spl-token');

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Token mints
const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

async function findRecentTransfers(fromAddress, limit = 50) {
  const pubkey = new PublicKey(fromAddress);
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit });

  const transfers = [];
  for (const sigInfo of signatures) {
    try {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta) continue;

      // Check for SOL transfers
      const accountKeys = tx.transaction.message.getAccountKeys();
      const preBalances = tx.meta.preBalances;
      const postBalances = tx.meta.postBalances;

      for (let i = 0; i < accountKeys.length; i++) {
        const preBal = preBalances[i];
        const postBal = postBalances[i];
        const change = (postBal - preBal) / LAMPORTS_PER_SOL;

        // If this account received SOL (positive change) and it's not the sender
        if (change > 0) {
          const receiverAddress = accountKeys[i].toBase58();
          if (receiverAddress !== fromAddress) {
            transfers.push({
              signature: sigInfo.signature,
              receiver: receiverAddress,
              amount: change,
              token: 'SOL',
              timestamp: sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000) : null,
            });
          }
        }
      }
    } catch (err) {
      console.error(`Error processing tx ${sigInfo.signature}:`, err.message);
    }
  }

  return transfers;
}

async function checkWalletBalance(address) {
  const pubkey = new PublicKey(address);
  const solBalance = await connection.getBalance(pubkey);

  // Check for USDC
  let usdcBalance = 0;
  try {
    const usdcAta = await getAssociatedTokenAddress(new PublicKey(TOKEN_MINTS.USDC), pubkey);
    const usdcAccount = await getAccount(connection, usdcAta);
    usdcBalance = Number(usdcAccount.amount) / 1e6;
  } catch {}

  // Check for USDT
  let usdtBalance = 0;
  try {
    const usdtAta = await getAssociatedTokenAddress(new PublicKey(TOKEN_MINTS.USDT), pubkey);
    const usdtAccount = await getAccount(connection, usdtAta);
    usdtBalance = Number(usdtAccount.amount) / 1e6;
  } catch {}

  return {
    sol: solBalance / LAMPORTS_PER_SOL,
    usdc: usdcBalance,
    usdt: usdtBalance,
  };
}

async function main() {
  const creatorAddress = process.argv[2];

  if (!creatorAddress) {
    console.error('Usage: node recover-stuck-airdrop-funds.js <creator-wallet-address>');
    process.exit(1);
  }

  console.log(`🔍 Scanning recent transfers from ${creatorAddress}...\n`);

  const transfers = await findRecentTransfers(creatorAddress, 100);

  if (transfers.length === 0) {
    console.log('No recent transfers found.');
    return;
  }

  console.log(`Found ${transfers.length} recent transfers. Checking balances...\n`);

  const candidates = [];
  for (const transfer of transfers) {
    // Skip very small amounts (likely not airdrop funding)
    if (transfer.amount < 0.001) continue;

    const balance = await checkWalletBalance(transfer.receiver);
    const totalValue = balance.sol + balance.usdc + balance.usdt;

    // Only show wallets with significant balances
    if (totalValue > 0.001) {
      candidates.push({
        address: transfer.receiver,
        transferAmount: transfer.amount,
        transferTime: transfer.timestamp,
        signature: transfer.signature,
        currentBalance: balance,
      });
    }
  }

  if (candidates.length === 0) {
    console.log('No wallets with stuck funds found.');
    return;
  }

  console.log('🚨 POTENTIALLY STUCK FUNDS FOUND:\n');
  console.log('='.repeat(80));

  candidates.forEach((candidate, i) => {
    console.log(`\n${i + 1}. Wallet: ${candidate.address}`);
    console.log(`   Original Transfer: ${candidate.transferAmount.toFixed(6)} SOL`);
    console.log(`   Time: ${candidate.transferTime?.toISOString() || 'Unknown'}`);
    console.log(`   Transaction: ${candidate.signature}`);
    console.log(`   Current Balance:`);
    console.log(`     - SOL: ${candidate.currentBalance.sol.toFixed(6)}`);
    console.log(`     - USDC: ${candidate.currentBalance.usdc.toFixed(2)}`);
    console.log(`     - USDT: ${candidate.currentBalance.usdt.toFixed(2)}`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('\n⚠️  IMPORTANT: These wallets likely contain stuck airdrop funds.');
  console.log(
    '   However, without the private keys (which were lost when airdrop creation failed),'
  );
  console.log('   these funds are currently unrecoverable.\n');
  console.log('   To prevent this in the future:');
  console.log('   1. The fix has been applied to wait for confirmation before verification');
  console.log('   2. Consider adding wallet recovery logging for failed airdrops\n');

  // Calculate total stuck
  const totalStuck = candidates.reduce((sum, c) => sum + c.currentBalance.sol, 0);
  console.log(`💸 Total stuck SOL: ${totalStuck.toFixed(6)}`);
}

main().catch(console.error);
