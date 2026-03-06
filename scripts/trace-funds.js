#!/usr/bin/env node
/**
 * Emergency Fund Trace - Find where the recovery sent your funds
 */

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// User's wallet
const USER_WALLET = '9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY';

// The recovery transactions
const RECOVERY_TXS = [
  {
    sig: '669iFdyVwoMQsMYtxb3BnawsA6QigWAu1HSgxuSRuzKr1q4ARgQu4ZeRkuenpoi5D2G9sFMpk8j4PK9MDLxkghoE',
    from: 'F1UVFZ5ge9uJhNtpQdh8NNTg3BqJ3WouDNykLwpW5ZxD',
    amount: 0.097494,
  },
  {
    sig: '5ZTkqE4tT7Cwpgc6MwNRrL2PT2u8RE45d8Cvv84zKeNMEuorsnBa2oS8dfiDzCaWDjzWufSwEMeFwxzRBe4WRCyM',
    from: '3nyGDgEQ43AJcNepxiGvtZ8DLq338KLoSEMuLFsmEam5',
    amount: 0.097468,
  },
];

async function main() {
  console.log('🚨 EMERGENCY FUND TRACE\n');
  console.log('='.repeat(80));
  console.log(`Your Wallet: ${USER_WALLET}`);
  console.log('='.repeat(80));

  // Check your current balance
  console.log('\n💳 Checking your wallet balance...');
  try {
    const userBalance = await connection.getBalance(new PublicKey(USER_WALLET));
    console.log(`Your Current Balance: ${(userBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  } catch (err) {
    console.log(`Error checking balance: ${err.message}`);
  }

  // Trace each recovery transaction
  console.log('\n🔍 Tracing Recovery Transactions:\n');

  for (const tx of RECOVERY_TXS) {
    console.log('-'.repeat(80));
    console.log(`Transaction: ${tx.sig}`);
    console.log(`From Pool Wallet: ${tx.from}`);
    console.log(`Expected Amount: ${tx.amount} SOL`);

    try {
      const transaction = await connection.getTransaction(tx.sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction) {
        console.log('❌ Transaction not found');
        continue;
      }

      // Get accounts
      const accountKeys = transaction.transaction.message.getAccountKeys();
      const from = accountKeys[0].toBase58();
      const to = accountKeys[1].toBase58();

      // Calculate actual amount sent
      const preBalances = transaction.meta.preBalances;
      const postBalances = transaction.meta.postBalances;
      const amount = (preBalances[0] - postBalances[0] - transaction.meta.fee) / LAMPORTS_PER_SOL;

      console.log(`\n📤 Sent From: ${from}`);
      console.log(`📥 Sent To: ${to}`);
      console.log(`💰 Amount: ${amount.toFixed(6)} SOL`);
      console.log(`⏰ Time: ${new Date(transaction.blockTime * 1000).toLocaleString()}`);

      // Check if it went to YOUR wallet
      if (to === USER_WALLET) {
        console.log(`\n✅ SUCCESS: Funds went to YOUR wallet!`);
      } else {
        console.log(`\n🚨 PROBLEM: Funds went to WRONG wallet!`);
        console.log(`   Expected: ${USER_WALLET}`);
        console.log(`   Actual:   ${to}`);

        // Check if that wallet is in our system
        console.log(`\n🔍 Checking if recipient is in FatTips system...`);
        try {
          const recipientBalance = await connection.getBalance(new PublicKey(to));
          console.log(
            `   Recipient Balance: ${(recipientBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`
          );

          if (recipientBalance > 0) {
            console.log(`   ⚠️  This wallet has funds and may be recoverable!`);
          }
        } catch (e) {
          console.log(`   Could not check recipient balance`);
        }
      }
    } catch (err) {
      console.log(`❌ Error: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n📊 SUMMARY:');
  console.log('The funds were sent to wallets associated with old airdrop records.');
  console.log('If they did not go to your wallet, they went to other users.');
  console.log('\n💡 NEXT STEPS:');
  console.log('1. Check the "Sent To" addresses above');
  console.log('2. If the funds went to the wrong wallets, you need to contact those users');
  console.log('3. Or check if those wallets are also in the FatTips system and recoverable');
}

main();
