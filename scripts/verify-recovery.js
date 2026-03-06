#!/usr/bin/env node
/**
 * Verify recovered funds transactions
 */

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

const signatures = [
  '669iFdyVwoMQsMYtxb3BnawsA6QigWAu1HSgxuSRuzKr1q4ARgQu4ZeRkuenpoi5D2G9sFMpk8j4PK9MDLxkghoE',
  '5ZTkqE4tT7Cwpgc6MwNRrL2PT2u8RE45d8Cvv84zKeNMEuorsnBa2oS8dfiDzCaWDjzWufSwEMeFwxzRBe4WRCyM',
];

async function main() {
  console.log('🔍 Verifying Recovery Transactions\n');
  console.log('='.repeat(60));

  for (const sig of signatures) {
    console.log(`\n📋 Transaction: ${sig}`);
    console.log('-'.repeat(60));

    try {
      const tx = await connection.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        console.log('  ❌ Transaction not found or not confirmed yet');
        continue;
      }

      // Get sender and receiver
      const accountKeys = tx.transaction.message.getAccountKeys();
      const from = accountKeys[0].toBase58();
      const to = accountKeys[1].toBase58();

      // Calculate amount
      const preBalance = tx.meta.preBalances[0];
      const postBalance = tx.meta.postBalances[0];
      const amount = (preBalance - postBalance - tx.meta.fee) / LAMPORTS_PER_SOL;

      console.log(`  ✅ Status: CONFIRMED`);
      console.log(`  📤 From: ${from}`);
      console.log(`  📥 To: ${to}`);
      console.log(`  💰 Amount: ${amount.toFixed(6)} SOL`);
      console.log(`  ⏰ Timestamp: ${new Date(tx.blockTime * 1000).toLocaleString()}`);

      // Check current balance of recipient
      const recipientBalance = await connection.getBalance(new PublicKey(to));
      console.log(
        `  💳 Recipient Balance: ${(recipientBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Summary:');
  console.log('The funds were sent to the creators of the failed airdrops.');
  console.log('Check the "To" addresses above to see who received the funds.');
}

main();
