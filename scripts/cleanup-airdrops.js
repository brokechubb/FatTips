#!/usr/bin/env node
/**
 * Weekly Airdrop Wallet Cleanup Script
 *
 * Usage:
 *   node cleanup-airdrops.js [DESTINATION_WALLET] [DATABASE_URL] [MASTER_ENCRYPTION_KEY] [SOLANA_RPC_URL]
 *
 * Or set environment variables:
 *   CLEANUP_DESTINATION, DATABASE_URL, MASTER_ENCRYPTION_KEY, SOLANA_RPC_URL
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
const FEE_BUFFER = 5000;

// Default destination (environment variable or hardcoded)
const DEFAULT_DESTINATION =
  process.env.CLEANUP_DESTINATION || '9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

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
  const [, , destination, dbUrl, masterKey, rpcUrl] = process.argv;

  if (!destination || !dbUrl || !masterKey || !rpcUrl) {
    console.log(
      'Usage: node cleanup-airdrops.js <DESTINATION> <DATABASE_URL> <MASTER_KEY> <RPC_URL>'
    );
    console.log(
      'Example: node cleanup-airdrops.js 9HM... postgresql://... masterkey... https://...'
    );
    process.exit(1);
  }

  console.log(`${colors.cyan}===============================================${colors.reset}`);
  console.log(`${colors.cyan}  Weekly Airdrop Wallet Cleanup${colors.reset}`);
  console.log(`${colors.cyan}===============================================${colors.reset}\n`);
  console.log(`${colors.blue}Destination:${colors.reset} ${destination}\n`);

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');
  const masterKeyBuffer = Buffer.from(masterKey, 'base64');
  const destPubkey = new PublicKey(destination);

  try {
    await pgClient.connect();
    console.log(`${colors.blue}Connected to database${colors.reset}`);

    const result = await pgClient.query(`
      SELECT id, "walletPubkey", "encryptedPrivkey", "keySalt", status
      FROM "Airdrop"
      WHERE status IN ('SETTLED', 'EXPIRED')
        AND "cleanedUpAt" IS NULL
      ORDER BY "createdAt" DESC
    `);
    const airdrops = result.rows;
    console.log(`${colors.blue}Found ${airdrops.length} airdrop wallets to check\n${colors.reset}`);

    let totalDrained = 0,
      successCount = 0,
      emptyCount = 0,
      errorCount = 0;

    for (let i = 0; i < airdrops.length; i++) {
      const a = airdrops[i];
      process.stdout.write(`[${i + 1}/${airdrops.length}] ${a.id.substring(0, 8)}... `);

      try {
        const privateKey = await decryptPrivateKey(a.encryptedPrivkey, a.keySalt, masterKeyBuffer);
        const keypair = Keypair.fromSecretKey(privateKey);

        if (keypair.publicKey.toBase58() !== a.walletPubkey) {
          console.log(`${colors.yellow}⚠️  Keypair mismatch${colors.reset}`);
          errorCount++;
          continue;
        }

        const balance = await connection.getBalance(keypair.publicKey);
        const balanceSol = balance / LAMPORTS_PER_SOL;

        if (balance <= FEE_BUFFER) {
          // Mark empty wallet as cleaned so we don't check it again
          await pgClient.query('UPDATE "Airdrop" SET "cleanedUpAt" = NOW() WHERE id = $1', [a.id]);
          console.log(`${colors.gray}Empty (${balanceSol.toFixed(9)} SOL)${colors.reset}`);
          emptyCount++;
          continue;
        }

        const drainAmount = balance - FEE_BUFFER;
        const drainSol = drainAmount / LAMPORTS_PER_SOL;

        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: destPubkey,
            lamports: drainAmount,
          })
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);

        // Mark as cleaned up in database
        await pgClient.query('UPDATE "Airdrop" SET "cleanedUpAt" = NOW() WHERE id = $1', [a.id]);

        console.log(`${colors.green}✅ Drained ${drainSol.toFixed(9)} SOL${colors.reset}`);
        totalDrained += drainSol;
        successCount++;

        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        // Mark as cleaned even on error so we don't retry every week
        try {
          await pgClient.query('UPDATE "Airdrop" SET "cleanedUpAt" = NOW() WHERE id = $1', [a.id]);
        } catch {}
        console.log(`${colors.red}❌ Error: ${err.message.substring(0, 50)}${colors.reset}`);
        errorCount++;
      }
    }

    console.log(`\n${colors.cyan}===============================================${colors.reset}`);
    console.log(`${colors.cyan}  Cleanup Complete${colors.reset}`);
    console.log(`${colors.cyan}===============================================${colors.reset}`);
    console.log(`${colors.green}Total Drained:${colors.reset} ${totalDrained.toFixed(9)} SOL`);
    console.log(`${colors.green}Wallets Drained:${colors.reset} ${successCount}`);
    console.log(`${colors.yellow}Empty Wallets:${colors.reset} ${emptyCount}`);
    console.log(`${colors.red}Errors:${colors.reset} ${errorCount}\n`);

    if (totalDrained > 0) {
      console.log(
        `${colors.green}💰 Successfully recovered ${totalDrained.toFixed(9)} SOL!${colors.reset}\n`
      );
    }

    process.exit(0);
  } catch (err) {
    console.error(`\n${colors.red}❌ Fatal Error: ${err.message}${colors.reset}`);
    process.exit(1);
  } finally {
    await pgClient.end();
  }
}

main();
