#!/usr/bin/env node
/**
 * Emergency Airdrop Fund Recovery Script
 *
 * This script recovers funds from failed airdrop pool wallets.
 * Usage: node recover-airdrop-funds.js
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
const {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} = require('@solana/spl-token');
const { Client } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2Async = promisify(crypto.pbkdf2);

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

const TOKEN_MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

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

async function getTokenBalance(connection, walletPubkey, mint) {
  try {
    const mintPubkey = new PublicKey(mint);
    const wallet = new PublicKey(walletPubkey);
    const associatedTokenAddress = await getAssociatedTokenAddress(mintPubkey, wallet);
    const tokenAccount = await getAccount(connection, associatedTokenAddress);
    return Number(tokenAccount.amount) / 1e6;
  } catch {
    return 0;
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  const rpcUrl = process.env.SOLANA_RPC_URL;

  if (!dbUrl || !masterKey || !rpcUrl) {
    console.error(`${colors.red}Error: Missing environment variables${colors.reset}`);
    console.error('Please set: DATABASE_URL, MASTER_ENCRYPTION_KEY, SOLANA_RPC_URL');
    process.exit(1);
  }

  console.log(`${colors.cyan}===============================================${colors.reset}`);
  console.log(`${colors.cyan}  Emergency Airdrop Fund Recovery${colors.reset}`);
  console.log(`${colors.cyan}===============================================${colors.reset}\n`);

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');
  const masterKeyBuffer = Buffer.from(masterKey, 'base64');

  try {
    await pgClient.connect();
    console.log(`${colors.blue}Connected to database${colors.reset}\n`);

    // Find ALL pool wallets to check for stranded funds
    // Don't filter by isBusy - check every wallet that has keys in the database
    // Prefer FAILED/ACTIVE airdrops (unsettled funds) over SETTLED ones,
    // since pool wallets are reused and the most recent airdrop by date
    // may belong to a different user than the one whose funds are stranded.
    const result = await pgClient.query(`
      SELECT
        w.address,
        w."encryptedPrivkey",
        w."keySalt",
        w."isBusy",
        w."lastUsedAt",
        a.id as "airdropId",
        a.status as "airdropStatus",
        a."amountTotal",
        a."tokenMint",
        a."creatorId",
        u."walletPubkey" as "creatorWallet"
      FROM "AirdropPoolWallet" w
      LEFT JOIN "Airdrop" a ON w.address = a."walletPubkey"
        AND a.id = (
          SELECT id FROM "Airdrop"
          WHERE "walletPubkey" = w.address
          ORDER BY
            CASE status
              WHEN 'FAILED' THEN 0
              WHEN 'ACTIVE' THEN 1
              WHEN 'EXPIRED' THEN 2
              ELSE 3
            END,
            "createdAt" DESC
          LIMIT 1
        )
      LEFT JOIN "User" u ON a."creatorId" = u."discordId"
      ORDER BY w."lastUsedAt" DESC
      LIMIT 50
    `);

    console.log(
      `${colors.yellow}Found ${result.rows.length} pool wallets to check${colors.reset}\n`
    );

    let totalRecoveredSol = 0;
    let totalRecoveredUsdc = 0;
    let totalRecoveredUsdt = 0;

    for (const row of result.rows) {
      console.log(`${colors.cyan}Checking wallet: ${row.address}${colors.reset}`);
      console.log(`  Airdrop ID: ${row.airdropId || 'N/A'}`);
      console.log(`  Status: ${row.airdropStatus || 'N/A'}`);
      console.log(`  Creator: ${row.creatorId || 'N/A'}`);
      console.log(`  Is Busy: ${row.isBusy}`);

      if (!row.creatorWallet) {
        console.log(`  ${colors.yellow}⚠️ No creator wallet found, skipping${colors.reset}\n`);
        continue;
      }

      try {
        // Check balances
        const pubkey = new PublicKey(row.address);
        const solBalance = await connection.getBalance(pubkey);
        const usdcBalance = await getTokenBalance(connection, row.address, TOKEN_MINTS.USDC);
        const usdtBalance = await getTokenBalance(connection, row.address, TOKEN_MINTS.USDT);

        const solAmount = solBalance / LAMPORTS_PER_SOL;

        console.log(`  SOL: ${solAmount.toFixed(6)}`);
        console.log(`  USDC: ${usdcBalance.toFixed(2)}`);
        console.log(`  USDT: ${usdtBalance.toFixed(2)}`);

        if (solAmount < 0.001 && usdcBalance === 0 && usdtBalance === 0) {
          console.log(`  ${colors.gray}ℹ️ Empty wallet, marking as available${colors.reset}\n`);

          // Release the wallet back to the pool
          await pgClient.query(
            `UPDATE "AirdropPoolWallet" SET "isBusy" = false WHERE address = $1`,
            [row.address]
          );

          // Delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        console.log(`  ${colors.green}💰 Found funds! Recovering to creator...${colors.reset}`);

        // Decrypt private key
        const privateKey = await decryptPrivateKey(
          row.encryptedPrivkey,
          row.keySalt,
          masterKeyBuffer
        );
        const keypair = Keypair.fromSecretKey(privateKey);

        const creatorPubkey = new PublicKey(row.creatorWallet);
        const signatures = [];

        // Recover USDC
        if (usdcBalance > 0) {
          try {
            const mintPubkey = new PublicKey(TOKEN_MINTS.USDC);
            const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, pubkey);
            const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, creatorPubkey);

            const tx = new Transaction();

            // Check if recipient token account exists
            try {
              await getAccount(connection, toTokenAccount);
            } catch {
              // Create recipient token account
              tx.add(
                createAssociatedTokenAccountInstruction(
                  keypair.publicKey,
                  toTokenAccount,
                  creatorPubkey,
                  mintPubkey
                )
              );
            }

            tx.add(
              createTransferInstruction(
                fromTokenAccount,
                toTokenAccount,
                keypair.publicKey,
                Math.floor(usdcBalance * 1e6)
              )
            );

            const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
              skipPreflight: true,
              commitment: 'confirmed',
            });
            signatures.push({ token: 'USDC', amount: usdcBalance, sig });
            totalRecoveredUsdc += usdcBalance;
            console.log(
              `    ${colors.green}✓ Recovered ${usdcBalance.toFixed(2)} USDC${colors.reset}`
            );
          } catch (err) {
            console.log(`    ${colors.red}✗ Failed to recover USDC: ${err.message}${colors.reset}`);
          }
        }

        // Recover USDT
        if (usdtBalance > 0) {
          try {
            const mintPubkey = new PublicKey(TOKEN_MINTS.USDT);
            const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, pubkey);
            const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, creatorPubkey);

            const tx = new Transaction();

            try {
              await getAccount(connection, toTokenAccount);
            } catch {
              tx.add(
                createAssociatedTokenAccountInstruction(
                  keypair.publicKey,
                  toTokenAccount,
                  creatorPubkey,
                  mintPubkey
                )
              );
            }

            tx.add(
              createTransferInstruction(
                fromTokenAccount,
                toTokenAccount,
                keypair.publicKey,
                Math.floor(usdtBalance * 1e6)
              )
            );

            const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
              skipPreflight: true,
              commitment: 'confirmed',
            });
            signatures.push({ token: 'USDT', amount: usdtBalance, sig });
            totalRecoveredUsdt += usdtBalance;
            console.log(
              `    ${colors.green}✓ Recovered ${usdtBalance.toFixed(2)} USDT${colors.reset}`
            );
          } catch (err) {
            console.log(`    ${colors.red}✗ Failed to recover USDT: ${err.message}${colors.reset}`);
          }
        }

        // Recover SOL (leave enough for rent + fees)
        // Need to leave: rent exemption (0.00089) + tx fee (0.000005) + safety margin (0.0001)
        const rentExemption = 0.00089;
        const txFee = 0.000005;
        const safetyMargin = 0.0001;
        const minRequired = rentExemption + txFee + safetyMargin;
        const recoverableSol = Math.max(0, solAmount - minRequired);

        if (recoverableSol > 0.00001) {
          try {
            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: creatorPubkey,
                lamports: Math.floor(recoverableSol * LAMPORTS_PER_SOL),
              })
            );

            const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
              skipPreflight: true,
              commitment: 'confirmed',
            });
            signatures.push({ token: 'SOL', amount: recoverableSol, sig });
            totalRecoveredSol += recoverableSol;
            console.log(
              `    ${colors.green}✓ Recovered ${recoverableSol.toFixed(6)} SOL${colors.reset}`
            );
          } catch (err) {
            console.log(`    ${colors.red}✗ Failed to recover SOL: ${err.message}${colors.reset}`);
          }
        }

        // Mark wallet as available
        await pgClient.query(`UPDATE "AirdropPoolWallet" SET "isBusy" = false WHERE address = $1`, [
          row.address,
        ]);

        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Update airdrop status if exists
        if (row.airdropId) {
          await pgClient.query(`UPDATE "Airdrop" SET status = 'RECLAIMED' WHERE id = $1`, [
            row.airdropId,
          ]);
        }

        // Print signatures
        if (signatures.length > 0) {
          console.log(`\n  ${colors.blue}Transaction Signatures:${colors.reset}`);
          signatures.forEach((s) => {
            console.log(`    ${s.token}: ${s.sig}`);
          });
        }

        console.log();
      } catch (err) {
        console.log(`  ${colors.red}✗ Error processing wallet: ${err.message}${colors.reset}\n`);
      }
    }

    console.log(`${colors.cyan}===============================================${colors.reset}`);
    console.log(`${colors.green}Recovery Complete!${colors.reset}`);
    console.log(`${colors.cyan}===============================================${colors.reset}`);
    console.log(`Total Recovered:`);
    console.log(`  SOL:  ${totalRecoveredSol.toFixed(6)}`);
    console.log(`  USDC: ${totalRecoveredUsdc.toFixed(2)}`);
    console.log(`  USDT: ${totalRecoveredUsdt.toFixed(2)}`);
  } catch (err) {
    console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
    console.error(err);
    process.exit(1);
  } finally {
    await pgClient.end();
  }
}

main();
