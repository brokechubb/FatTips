#!/usr/bin/env node
/**
 * Flush All Pool Wallets
 *
 * Drains ALL airdrop pool wallets (SOL, USDC, USDT) to a single destination address.
 * Unlike recover-airdrop-funds.js (which sends to each airdrop's creator), this
 * sends everything to one specified wallet regardless of airdrop state.
 *
 * Use with extreme caution — this moves funds from ALL pool wallets, including
 * busy ones that may have active airdrops.
 *
 * Usage:
 *   node flush-all-pool-wallets.js <DESTINATION_WALLET> [DATABASE_URL] [MASTER_ENCRYPTION_KEY] [SOLANA_RPC_URL]
 *
 * Alternatively via env vars:
 *   DATABASE_URL=... MASTER_ENCRYPTION_KEY=... SOLANA_RPC_URL=... \
 *   node flush-all-pool-wallets.js <DESTINATION_WALLET>
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

const WALLET_DELAY_MS = parseInt(process.env.WALLET_DELAY_MS || '3000', 10);

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

async function getTokenBalances(connection, walletPubkey, mints) {
  const pubkey = new PublicKey(walletPubkey);
  const ataPromises = Object.entries(mints).map(async ([name, mint]) => {
    const mintPubkey = new PublicKey(mint);
    const ata = await getAssociatedTokenAddress(mintPubkey, pubkey);
    return { name, ata, mint: mintPubkey };
  });
  const ataEntries = await Promise.all(ataPromises);

  const ataPubkeys = ataEntries.map((e) => e.ata);
  const ataInfos = await connection.getMultipleAccountsInfo(ataPubkeys);

  const result = {};
  for (let i = 0; i < ataEntries.length; i++) {
    const info = ataInfos[i];
    if (info) {
      const amount = Number(info.data.readBigUInt64LE(64));
      result[ataEntries[i].name] = amount / 1e6;
    } else {
      result[ataEntries[i].name] = 0;
    }
  }
  return result;
}

const PRIORITY_FEE_MICRO_LAMPORTS = 50_000;
const CU_LIMIT = 60_000;

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
    const currentHeight = await connection.getBlockHeight('confirmed');
    if (currentHeight > lastValidBlockHeight) {
      throw new Error('block height exceeded');
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('Confirmation timed out');
}

async function sendWithRetry(connection, instructions, signer, maxRetries = 5) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const tx = new Transaction();
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
  const args = process.argv.slice(2);

  const destination = args[0];
  const dbUrl = args[1] || process.env.DATABASE_URL;
  const masterKey = args[2] || process.env.MASTER_ENCRYPTION_KEY;
  const rpcUrl = args[3] || process.env.SOLANA_RPC_URL;

  if (!destination || !dbUrl || !masterKey || !rpcUrl) {
    console.log('Usage: node flush-all-pool-wallets.js <DESTINATION_WALLET> [DATABASE_URL] [MASTER_KEY] [RPC_URL]');
    console.log('Or set DATABASE_URL, MASTER_ENCRYPTION_KEY, SOLANA_RPC_URL as env vars');
    process.exit(1);
  }

  console.log(`${colors.cyan}===============================================${colors.reset}`);
  console.log(`${colors.cyan}  Flush All Pool Wallets${colors.reset}`);
  console.log(`${colors.cyan}===============================================${colors.reset}\n`);
  console.log(`${colors.yellow}⚠️  THIS WILL DRAIN ALL POOL WALLETS INCLUDING BUSY ONES${colors.reset}`);
  console.log(`${colors.blue}Destination:${colors.reset} ${destination}\n`);

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');
  const masterKeyBuffer = Buffer.from(masterKey, 'base64');
  const destPubkey = new PublicKey(destination);

  try {
    await pgClient.connect();
    console.log(`${colors.blue}Connected to database${colors.reset}\n`);

    const result = await pgClient.query(`
      SELECT address, "encryptedPrivkey", "keySalt", "isBusy", "lastUsedAt"
      FROM "AirdropPoolWallet"
      ORDER BY "lastUsedAt" DESC
    `);

    const wallets = result.rows;
    console.log(`${colors.yellow}Found ${wallets.length} total pool wallets${colors.reset}`);

    // --- Phase 1: Batch-check all SOL balances ---
    console.log(`\n${colors.blue}Phase 1: Batch-checking SOL balances...${colors.reset}`);
    const walletPubkeys = wallets.map((w) => new PublicKey(w.address));
    const accountInfos = await connection.getMultipleAccountsInfo(walletPubkeys);

    for (let i = 0; i < wallets.length; i++) {
      wallets[i]._solBalance = accountInfos[i]?.lamports ?? 0;
      wallets[i]._solAmount = wallets[i]._solBalance / LAMPORTS_PER_SOL;
    }

    const nonDustWallets = wallets.filter(
      (w) => w._solAmount >= 0.001
    );
    const dustWallets = wallets.filter(
      (w) => w._solAmount > 0 && w._solAmount < 0.001
    );
    const zeroWallets = wallets.filter((w) => w._solBalance === 0);

    console.log(`  Non-dust (>0.001 SOL): ${colors.green}${nonDustWallets.length}${colors.reset}`);
    console.log(`  Dust (rent only):      ${colors.yellow}${dustWallets.length}${colors.reset}`);
    console.log(`  Zero balance:          ${colors.gray}${zeroWallets.length}${colors.reset}`);

    // --- Phase 2: Batch-check SPL tokens for wallets with any SOL ---
    const walletsToCheckTokens = wallets.filter((w) => w._solBalance > 0);
    let tokenBalances = {};

    if (walletsToCheckTokens.length > 0) {
      console.log(`\n${colors.blue}Phase 2: Batch-checking SPL token balances...${colors.reset}`);
      const allAtaEntries = [];
      for (const w of walletsToCheckTokens) {
        const pubkey = new PublicKey(w.address);
        for (const [name, mint] of Object.entries(TOKEN_MINTS)) {
          const mintPubkey = new PublicKey(mint);
          const ata = await getAssociatedTokenAddress(mintPubkey, pubkey);
          allAtaEntries.push({ address: w.address, name, ata });
        }
      }

      const ataPubkeys = allAtaEntries.map((e) => e.ata);
      const ataInfos = await connection.getMultipleAccountsInfo(ataPubkeys);

      for (let i = 0; i < allAtaEntries.length; i++) {
        const entry = allAtaEntries[i];
        const info = ataInfos[i];
        if (!tokenBalances[entry.address]) tokenBalances[entry.address] = {};
        if (info) {
          const amount = Number(info.data.readBigUInt64LE(64));
          tokenBalances[entry.address][entry.name] = amount / 1e6;
        } else {
          tokenBalances[entry.address][entry.name] = 0;
        }
      }

      const walletsWithTokens = walletsToCheckTokens.filter((w) => {
        const tb = tokenBalances[w.address] || {};
        return (tb.USDC || 0) > 0 || (tb.USDT || 0) > 0;
      });
      console.log(`  Wallets with SPL tokens: ${colors.green}${walletsWithTokens.length}${colors.reset}`);
    }

    // --- Phase 3: Process wallets that need draining ---
    const walletsToDrain = wallets.filter((w) => {
      const tb = tokenBalances[w.address] || {};
      return w._solAmount >= 0.001 || (tb.USDC || 0) > 0 || (tb.USDT || 0) > 0;
    });

    if (walletsToDrain.length === 0) {
      console.log(`\n${colors.green}✅ All wallets are empty — nothing to flush!${colors.reset}\n`);
      process.exit(0);
    }

    const zeroCount = zeroWallets.length;
    const dustCount = dustWallets.length;
    console.log(`\n${colors.blue}Phase 3: Draining ${walletsToDrain.length} wallets with funds...${colors.reset}`);
    console.log(`  (${zeroCount} zero-balance + ${dustCount} rent-dust wallets skipped)\n`);

    let totalSol = 0;
    let totalUsdc = 0;
    let totalUsdt = 0;
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < walletsToDrain.length; i++) {
      const w = walletsToDrain[i];
      const solBalance = w._solBalance;
      const solAmount = w._solAmount;
      const tb = tokenBalances[w.address] || {};
      const usdcBalance = tb.USDC || 0;
      const usdtBalance = tb.USDT || 0;

      console.log(`${colors.cyan}[${i + 1}/${walletsToDrain.length}] ${w.address}${colors.reset}`);
      console.log(`  Is Busy: ${w.isBusy}  |  Last Used: ${w.lastUsedAt}`);
      console.log(`  SOL: ${solAmount.toFixed(6)}  USDC: ${usdcBalance.toFixed(2)}  USDT: ${usdtBalance.toFixed(2)}`);

      try {
        const privateKey = await decryptPrivateKey(w.encryptedPrivkey, w.keySalt, masterKeyBuffer);
        const keypair = Keypair.fromSecretKey(privateKey);

        if (keypair.publicKey.toBase58() !== w.address) {
          console.log(`  ${colors.yellow}⚠️ Keypair mismatch, skipping${colors.reset}\n`);
          errorCount++;
          continue;
        }

        const pubkey = keypair.publicKey;
        let anyTransferFailed = false;
        const signatures = [];

        // Flush USDC
        if (usdcBalance > 0) {
          try {
            const mintPubkey = new PublicKey(TOKEN_MINTS.USDC);
            const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, pubkey);
            const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, destPubkey);

            const ixs = [];
            try {
              await getAccount(connection, toTokenAccount);
            } catch {
              ixs.push(
                createAssociatedTokenAccountInstruction(
                  keypair.publicKey,
                  toTokenAccount,
                  destPubkey,
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
            totalUsdc += usdcBalance;
            console.log(`  ${colors.green}✓ Flushed ${usdcBalance.toFixed(2)} USDC${colors.reset}`);
          } catch (err) {
            anyTransferFailed = true;
            console.log(`  ${colors.red}✗ USDC failed: ${err.message.substring(0, 80)}${colors.reset}`);
          }
        }

        // Flush USDT
        if (usdtBalance > 0) {
          try {
            const mintPubkey = new PublicKey(TOKEN_MINTS.USDT);
            const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, pubkey);
            const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, destPubkey);

            const ixs = [];
            try {
              await getAccount(connection, toTokenAccount);
            } catch {
              ixs.push(
                createAssociatedTokenAccountInstruction(
                  keypair.publicKey,
                  toTokenAccount,
                  destPubkey,
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
            totalUsdt += usdtBalance;
            console.log(`  ${colors.green}✓ Flushed ${usdtBalance.toFixed(2)} USDT${colors.reset}`);
          } catch (err) {
            anyTransferFailed = true;
            console.log(`  ${colors.red}✗ USDT failed: ${err.message.substring(0, 80)}${colors.reset}`);
          }
        }

        // Flush SOL
        const solBalanceFresh = await connection.getBalance(pubkey, 'confirmed');
        const solAmountFresh = solBalanceFresh / LAMPORTS_PER_SOL;
        const minRequired = 0.00089 + 0.000005 + 0.0001;
        const recoverableSol = Math.max(0, solAmountFresh - minRequired);

        if (recoverableSol > 0.00001) {
          try {
            const ixs = [
              SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: destPubkey,
                lamports: Math.floor(recoverableSol * LAMPORTS_PER_SOL),
              }),
            ];

            const sig = await sendWithRetry(connection, ixs, keypair);
            signatures.push({ token: 'SOL', amount: recoverableSol, sig });
            totalSol += recoverableSol;
            console.log(`  ${colors.green}✓ Flushed ${recoverableSol.toFixed(6)} SOL${colors.reset}`);
          } catch (err) {
            anyTransferFailed = true;
            console.log(`  ${colors.red}✗ SOL failed: ${err.message.substring(0, 80)}${colors.reset}`);
          }
        }

        if (!anyTransferFailed || signatures.length > 0) {
          await pgClient.query(
            `UPDATE "AirdropPoolWallet" SET "isBusy" = false WHERE address = $1`,
            [w.address]
          );
        } else {
          console.log(`  ${colors.yellow}⚠️ All transfers failed, wallet left busy${colors.reset}`);
        }

        if (signatures.length > 0) {
          console.log(`  ${colors.blue}Signatures:${colors.reset}`);
          signatures.forEach((s) => {
            console.log(`    ${s.token}: ${s.sig}`);
          });
        }

        console.log();
        successCount++;
        await new Promise((r) => setTimeout(r, WALLET_DELAY_MS));
      } catch (err) {
        console.log(`  ${colors.red}✗ Error: ${err.message.substring(0, 80)}${colors.reset}\n`);
        errorCount++;
      }
    }

    console.log(`${colors.cyan}===============================================${colors.reset}`);
    console.log(`${colors.green}  Flush Complete${colors.reset}`);
    console.log(`${colors.cyan}===============================================${colors.reset}`);
    console.log(`  Wallets Drained: ${successCount}`);
    console.log(`  Zero-balance:    ${zeroCount}`);
    console.log(`  Rent-dust only:  ${dustCount}`);
    console.log(`  Errors:          ${errorCount}`);
    console.log(`  SOL Flushed:     ${totalSol.toFixed(6)}`);
    console.log(`  USDC Flushed:    ${totalUsdc.toFixed(2)}`);
    console.log(`  USDT Flushed:    ${totalUsdt.toFixed(2)}`);
    console.log(`${colors.cyan}===============================================${colors.reset}\n`);

    process.exit(0);
  } catch (err) {
    console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
    process.exit(1);
  } finally {
    await pgClient.end();
  }
}

main();
