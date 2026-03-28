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
  PublicKey,
  ComputeBudgetProgram,
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

const PRIORITY_FEE_MICRO_LAMPORTS = 50_000;
// CU budget: ATA creation ~25k, SPL transfer ~4k, SOL transfer ~450, overhead ~2k.
// Use 60k to safely cover the worst case (ATA creation + SPL transfer).
const CU_LIMIT = 60_000;

/**
 * Poll getSignatureStatus until confirmed/finalized or block height exceeded.
 * Returns the signature on success, throws on failure or expiry.
 */
async function pollConfirmation(connection, sig, lastValidBlockHeight, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
    const val = status?.value;
    if (val) {
      if (val.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(val.err)}`);
      if (val.confirmationStatus === 'confirmed' || val.confirmationStatus === 'finalized') {
        return sig;
      }
    }
    // Check if the block window has passed so we don't poll forever
    const currentHeight = await connection.getBlockHeight('confirmed');
    if (currentHeight > lastValidBlockHeight) {
      throw new Error('block height exceeded');
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('Confirmation timed out');
}

/**
 * Build, sign, and send a transaction with priority fee + CU limit prepended.
 * Retries with a fresh blockhash up to maxRetries times on block-height expiry.
 * Other errors (on-chain failure, insufficient funds) throw immediately.
 */
async function sendWithRetry(connection, instructions, signer, maxRetries = 5) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const tx = new Transaction();
    // Always prepend priority fee + CU limit so validators prioritise this tx
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }),
      ...instructions
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;
    tx.sign(signer);

    let sig;
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    } catch (err) {
      // sendRawTransaction failures (e.g. node rejection) are not expiry — throw immediately
      throw err;
    }

    try {
      await pollConfirmation(connection, sig, lastValidBlockHeight);
      return sig;
    } catch (err) {
      lastError = err;
      const isExpiry =
        err.message?.includes('block height exceeded') ||
        err.message?.includes('Block height exceeded');

      if (isExpiry) {
        // Double-check: tx may have landed even though our poll expired
        const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const val = status?.value;
        if (
          val &&
          !val.err &&
          (val.confirmationStatus === 'confirmed' || val.confirmationStatus === 'finalized')
        ) {
          return sig;
        }
        if (attempt < maxRetries - 1) {
          console.log(
            `    Block height exceeded, retrying (attempt ${attempt + 2}/${maxRetries})...`
          );
          await new Promise((r) => setTimeout(r, 3_000));
          continue;
        }
      }
      throw err;
    }
  }
  throw lastError;
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

        let anyTransferFailed = false;

        // Recover USDC
        if (usdcBalance > 0) {
          try {
            const mintPubkey = new PublicKey(TOKEN_MINTS.USDC);
            const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, pubkey);
            const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, creatorPubkey);

            const ixs = [];
            try {
              await getAccount(connection, toTokenAccount);
            } catch {
              ixs.push(
                createAssociatedTokenAccountInstruction(
                  keypair.publicKey,
                  toTokenAccount,
                  creatorPubkey,
                  mintPubkey
                )
              );
            }
            ixs.push(
              createTransferInstruction(
                fromTokenAccount,
                toTokenAccount,
                keypair.publicKey,
                Math.floor(usdcBalance * 1e6)
              )
            );

            const sig = await sendWithRetry(connection, ixs, keypair);
            signatures.push({ token: 'USDC', amount: usdcBalance, sig });
            totalRecoveredUsdc += usdcBalance;
            console.log(
              `    ${colors.green}✓ Recovered ${usdcBalance.toFixed(2)} USDC${colors.reset}`
            );
          } catch (err) {
            anyTransferFailed = true;
            console.log(`    ${colors.red}✗ Failed to recover USDC: ${err.message}${colors.reset}`);
          }
        }

        // Recover USDT
        if (usdtBalance > 0) {
          try {
            const mintPubkey = new PublicKey(TOKEN_MINTS.USDT);
            const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, pubkey);
            const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, creatorPubkey);

            const ixs = [];
            try {
              await getAccount(connection, toTokenAccount);
            } catch {
              ixs.push(
                createAssociatedTokenAccountInstruction(
                  keypair.publicKey,
                  toTokenAccount,
                  creatorPubkey,
                  mintPubkey
                )
              );
            }
            ixs.push(
              createTransferInstruction(
                fromTokenAccount,
                toTokenAccount,
                keypair.publicKey,
                Math.floor(usdtBalance * 1e6)
              )
            );

            const sig = await sendWithRetry(connection, ixs, keypair);
            signatures.push({ token: 'USDT', amount: usdtBalance, sig });
            totalRecoveredUsdt += usdtBalance;
            console.log(
              `    ${colors.green}✓ Recovered ${usdtBalance.toFixed(2)} USDT${colors.reset}`
            );
          } catch (err) {
            anyTransferFailed = true;
            console.log(`    ${colors.red}✗ Failed to recover USDT: ${err.message}${colors.reset}`);
          }
        }

        // Recover SOL last (it pays fees for SPL txs above).
        // Re-fetch balance so we account for fees spent on SPL transfers above.
        const solBalanceFresh = await connection.getBalance(pubkey, 'confirmed');
        const solAmountFresh = solBalanceFresh / LAMPORTS_PER_SOL;
        // Leave enough for rent exemption + one more tx fee + small safety margin
        const minRequired = 0.00089 + 0.000005 + 0.0001;
        const recoverableSol = Math.max(0, solAmountFresh - minRequired);

        if (recoverableSol > 0.00001) {
          try {
            const ixs = [
              SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: creatorPubkey,
                lamports: Math.floor(recoverableSol * LAMPORTS_PER_SOL),
              }),
            ];

            const sig = await sendWithRetry(connection, ixs, keypair);
            signatures.push({ token: 'SOL', amount: recoverableSol, sig });
            totalRecoveredSol += recoverableSol;
            console.log(
              `    ${colors.green}✓ Recovered ${recoverableSol.toFixed(6)} SOL${colors.reset}`
            );
          } catch (err) {
            anyTransferFailed = true;
            console.log(`    ${colors.red}✗ Failed to recover SOL: ${err.message}${colors.reset}`);
          }
        }

        // Only update DB if at least one transfer succeeded (or wallet is now empty).
        // If everything failed, leave isBusy=true so the next run retries.
        if (!anyTransferFailed || signatures.length > 0) {
          await pgClient.query(
            `UPDATE "AirdropPoolWallet" SET "isBusy" = false WHERE address = $1`,
            [row.address]
          );
          if (row.airdropId) {
            await pgClient.query(`UPDATE "Airdrop" SET status = 'RECLAIMED' WHERE id = $1`, [
              row.airdropId,
            ]);
          }
        } else {
          console.log(
            `  ${colors.yellow}⚠️ All transfers failed — wallet left busy for next run${colors.reset}`
          );
        }

        // Pace between wallets to avoid hammering the RPC
        await new Promise((resolve) => setTimeout(resolve, 3_000));

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
