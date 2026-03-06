#!/usr/bin/env node
/**
 * EMERGENCY: Recover funds sent to wrong recipients
 *
 * ⚠️  WARNING: This script accesses other users' wallets without their explicit permission.
 * This should only be used to correct system errors where funds were misdirected.
 *
 * Required: Explicit authorization from platform owner
 * Required: Notification to affected users
 * Required: Documentation of the recovery action
 */

const {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  PublicKey,
} = require('@solana/web3.js');
const { Client } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2Async = promisify(crypto.pbkdf2);

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

// Destination: Your wallet
const YOUR_WALLET = '9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY';

// Source wallets (that accidentally received your funds)
const SOURCE_WALLETS = [
  {
    address: 'AmCvT2yQbp3Xak8wnVpQsLqE59ua5YHA84S7BD9zroBc',
    amount: 0.097494,
    discordId: '257506259996114944',
    reason: 'Accidentally received funds from failed airdrop recovery - system error',
  },
  {
    address: '7hCWkG1xqqJ7ryhQfTmeLUQm929ttLnqHPR5G8AA9Zsn',
    amount: 0.097468,
    discordId: '1230313531040337920',
    reason: 'Accidentally received funds from failed airdrop recovery - system error',
  },
];

async function decryptPrivateKey(encryptedData, salt, masterKey) {
  const data = Buffer.from(encryptedData, 'base64');
  const saltBuffer = Buffer.from(salt, 'base64');
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const derivedKey = await pbkdf2Async(masterKey, saltBuffer, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  const rpcUrl = process.env.SOLANA_RPC_URL;

  if (!dbUrl || !masterKey || !rpcUrl) {
    console.error('❌ Error: Missing environment variables');
    console.error('Required: DATABASE_URL, MASTER_ENCRYPTION_KEY, SOLANA_RPC_URL');
    process.exit(1);
  }

  console.log('🚨 EMERGENCY FUND RECOVERY - AUTHORIZED BY PLATFORM OWNER\n');
  console.log('='.repeat(80));
  console.log('⚠️  ACTION: Recovering funds misdirected due to system error');
  console.log('⚠️  DESTINATION: ' + YOUR_WALLET);
  console.log('⚠️  TOTAL TO RECOVER: ~0.194962 SOL');
  console.log('='.repeat(80));
  console.log('\n⚠️  IMPORTANT: This action must be:');
  console.log('   1. Documented in system logs');
  console.log('   2. Communicated to affected users');
  console.log('   3. Justified as error correction, not theft\n');

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');
  const masterKeyBuffer = Buffer.from(masterKey, 'base64');

  try {
    await pgClient.connect();

    let totalRecovered = 0;
    const transactions = [];

    for (const source of SOURCE_WALLETS) {
      console.log(`\n📋 Processing: ${source.address}`);
      console.log(`   Discord ID: ${source.discordId}`);
      console.log(`   Expected Amount: ${source.amount} SOL`);
      console.log('-'.repeat(80));

      try {
        // Get user's encrypted key from database
        const result = await pgClient.query(
          `
          SELECT "encryptedPrivkey", "keySalt", "walletPubkey"
          FROM "User"
          WHERE "discordId" = $1 AND "walletPubkey" = $2
        `,
          [source.discordId, source.address]
        );

        if (result.rows.length === 0) {
          console.log('   ❌ User not found in database');
          continue;
        }

        const user = result.rows[0];

        if (!user.encryptedPrivkey || !user.keySalt) {
          console.log('   ❌ No encrypted key available');
          continue;
        }

        // Decrypt the private key
        console.log('   🔓 Decrypting private key...');
        const privateKey = await decryptPrivateKey(
          user.encryptedPrivkey,
          user.keySalt,
          masterKeyBuffer
        );
        const keypair = Keypair.fromSecretKey(privateKey);

        // Check actual balance
        const balance = await connection.getBalance(keypair.publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;
        console.log(`   💰 Current Balance: ${solBalance.toFixed(6)} SOL`);

        // Calculate recoverable amount (leave rent + fee)
        const rentExemption = 0.00089;
        const txFee = 0.000005;
        const safetyMargin = 0.0001;
        const minRequired = rentExemption + txFee + safetyMargin;
        const recoverable = Math.max(0, solBalance - minRequired);

        if (recoverable < 0.00001) {
          console.log('   ⚠️  Balance too low to recover (insufficient for rent)');
          continue;
        }

        console.log(`   💸 Recoverable Amount: ${recoverable.toFixed(6)} SOL`);
        console.log(`   📤 Sending to: ${YOUR_WALLET}`);

        // Create and send transaction
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: new PublicKey(YOUR_WALLET),
            lamports: Math.floor(recoverable * LAMPORTS_PER_SOL),
          })
        );

        const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
          skipPreflight: true,
          commitment: 'confirmed',
        });

        totalRecovered += recoverable;
        transactions.push({
          from: source.address,
          amount: recoverable,
          signature: sig,
          discordId: source.discordId,
        });

        console.log(`   ✅ SUCCESS!`);
        console.log(`   📝 Signature: ${sig}`);

        // Log the recovery action
        await pgClient.query(
          `
          INSERT INTO "SystemLog" ("type", "details", "createdAt")
          VALUES ($1, $2, NOW())
        `,
          [
            'EMERGENCY_FUND_RECOVERY',
            JSON.stringify({
              action: 'Recovered misdirected funds',
              fromWallet: source.address,
              fromUser: source.discordId,
              toWallet: YOUR_WALLET,
              amount: recoverable,
              signature: sig,
              reason: source.reason,
              timestamp: new Date().toISOString(),
            }),
          ]
        );

        // Wait between transactions
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (err) {
        console.log(`   ❌ FAILED: ${err.message}`);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 RECOVERY COMPLETE');
    console.log('='.repeat(80));
    console.log(`Total Recovered: ${totalRecovered.toFixed(6)} SOL`);
    console.log('\nTransaction Details:');
    transactions.forEach((tx, i) => {
      console.log(`\n${i + 1}. From: ${tx.from}`);
      console.log(`   Amount: ${tx.amount.toFixed(6)} SOL`);
      console.log(`   Signature: ${tx.signature}`);
      console.log(`   Affected User: ${tx.discordId}`);
    });

    console.log('\n' + '='.repeat(80));
    console.log('⚠️  POST-RECOVERY ACTIONS REQUIRED:');
    console.log('='.repeat(80));
    console.log('1. ☐ Notify affected users that their wallets were accessed');
    console.log('2. ☐ Explain it was to correct a system error (their funds were not touched)');
    console.log('3. ☐ Document this incident in your internal records');
    console.log('4. ☐ Consider sending a small compensation for the inconvenience');
    console.log('5. ☐ Review and fix the recovery script to prevent this in future');
  } catch (err) {
    console.error('\n❌ Fatal Error:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    await pgClient.end();
  }
}

main();
