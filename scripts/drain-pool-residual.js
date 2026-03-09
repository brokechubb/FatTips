#!/usr/bin/env node
/**
 * Drain Pool Wallets with Residual Balances
 *
 * This script drains SOL from pool wallets that have residual balances
 * but are not currently in use (isBusy=false).
 *
 * Usage:
 *   node drain-pool-residual.js [DESTINATION_WALLET] [DATABASE_URL] [MASTER_ENCRYPTION_KEY] [SOLANA_RPC_URL]
 */

const { Client } = require('pg');
const {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  PublicKey,
} = require('@solana/web3.js');
const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2Async = promisify(crypto.pbkdf2);

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const FEE_BUFFER = 5000;

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
      'Usage: node drain-pool-residual.js <DESTINATION> <DATABASE_URL> <MASTER_KEY> <RPC_URL>'
    );
    process.exit(1);
  }

  console.log(`${colors.cyan}===============================================${colors.reset}`);
  console.log(`${colors.cyan}  Pool Wallet Residual Balance Drainer${colors.reset}`);
  console.log(`${colors.cyan}===============================================${colors.reset}\n`);
  console.log(`${colors.blue}Destination:${colors.reset} ${destination}\n`);

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');
  const masterKeyBuffer = Buffer.from(masterKey, 'base64');
  const destPubkey = new PublicKey(destination);

  try {
    await pgClient.connect();
    console.log(`${colors.blue}Connected to database${colors.reset}`);

    // Get all free pool wallets (not in use)
    const result = await pgClient.query(`
      SELECT address, "encryptedPrivkey", "keySalt"
      FROM "AirdropPoolWallet"
      WHERE "isBusy" = false
      ORDER BY "lastUsedAt" DESC
    `);

    const wallets = result.rows;
    console.log(
      `${colors.blue}Found ${wallets.length} free pool wallets to check\n${colors.reset}`
    );

    let totalDrained = 0;
    let successCount = 0;
    let emptyCount = 0;
    let errorCount = 0;

    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      process.stdout.write(`[${i + 1}/${wallets.length}] ${w.address.substring(0, 20)}... `);

      try {
        // Check balance first
        const pubkey = new PublicKey(w.address);
        const balance = await connection.getBalance(pubkey);
        const balanceSol = balance / LAMPORTS_PER_SOL;

        if (balance <= FEE_BUFFER) {
          console.log(`${colors.gray}Empty (${balanceSol.toFixed(9)} SOL)${colors.reset}`);
          emptyCount++;
          continue;
        }

        // Decrypt and drain
        const privateKey = await decryptPrivateKey(w.encryptedPrivkey, w.keySalt, masterKeyBuffer);
        const keypair = Keypair.fromSecretKey(privateKey);

        if (keypair.publicKey.toBase58() !== w.address) {
          console.log(`${colors.yellow}⚠️  Keypair mismatch${colors.reset}`);
          errorCount++;
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

        console.log(`${colors.green}✅ Drained ${drainSol.toFixed(9)} SOL${colors.reset}`);
        console.log(`   Tx: ${signature}`);
        totalDrained += drainSol;
        successCount++;

        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
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
