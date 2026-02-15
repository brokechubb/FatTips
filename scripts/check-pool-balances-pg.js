#!/usr/bin/env node
/**
 * Check Pool Wallet Balances (PostgreSQL version)
 *
 * This script checks all airdrop pool wallets to see if any have balances
 * from failed airdrops or incomplete settlements.
 *
 * Usage:
 *   node check-pool-balances-pg.js [DATABASE_URL] [SOLANA_RPC_URL]
 *
 * Or set environment variables:
 *   DATABASE_URL, SOLANA_RPC_URL
 */

const { Client } = require('pg');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');

const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
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

async function getBalances(connection, walletPubkey) {
  const pubkey = new PublicKey(walletPubkey);

  // Get SOL balance
  const solBalance = await connection.getBalance(pubkey, 'confirmed');

  // Get USDC balance
  let usdcBalance = 0;
  try {
    const usdcMint = new PublicKey(TOKEN_MINTS.USDC);
    const usdcATA = await getAssociatedTokenAddress(usdcMint, pubkey);
    const usdcAccount = await getAccount(connection, usdcATA, 'confirmed');
    usdcBalance = Number(usdcAccount.amount) / 1e6;
  } catch {}

  // Get USDT balance
  let usdtBalance = 0;
  try {
    const usdtMint = new PublicKey(TOKEN_MINTS.USDT);
    const usdtATA = await getAssociatedTokenAddress(usdtMint, pubkey);
    const usdtAccount = await getAccount(connection, usdtATA, 'confirmed');
    usdtBalance = Number(usdtAccount.amount) / 1e6;
  } catch {}

  return {
    sol: solBalance / 1e9,
    usdc: usdcBalance,
    usdt: usdtBalance,
  };
}

async function main() {
  const [, , dbUrl, rpcUrl] = process.argv;

  if (!dbUrl || !rpcUrl) {
    console.log('Usage: node check-pool-balances-pg.js <DATABASE_URL> <RPC_URL>');
    console.log('Example: node check-pool-balances-pg.js postgresql://... https://...');
    process.exit(1);
  }

  console.log(`${colors.cyan}===============================================${colors.reset}`);
  console.log(`${colors.cyan}  Pool Wallet Balance Check${colors.reset}`);
  console.log(`${colors.cyan}===============================================${colors.reset}\n`);

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');

  try {
    await pgClient.connect();
    console.log(`${colors.blue}Connected to database${colors.reset}\n`);

    // Get all pool wallets
    const result = await pgClient.query(
      'SELECT address, "isBusy", "lastUsedAt" FROM "AirdropPoolWallet" ORDER BY "lastUsedAt" DESC'
    );
    const poolWallets = result.rows;

    console.log(`${colors.blue}Found ${poolWallets.length} pool wallets${colors.reset}\n`);

    let walletsWithBalance = [];
    let totalSol = 0;
    let totalUsdc = 0;
    let totalUsdt = 0;

    for (let i = 0; i < poolWallets.length; i++) {
      const wallet = poolWallets[i];
      process.stdout.write(
        `[${i + 1}/${poolWallets.length}] ${wallet.address.substring(0, 20)}... `
      );

      try {
        const balances = await getBalances(connection, wallet.address);

        // Consider non-zero if more than dust amounts
        const hasBalance = balances.sol > 0.001 || balances.usdc > 0.01 || balances.usdt > 0.01;

        if (hasBalance) {
          walletsWithBalance.push({
            address: wallet.address,
            isBusy: wallet.isBusy,
            balances,
          });
          totalSol += balances.sol;
          totalUsdc += balances.usdc;
          totalUsdt += balances.usdt;

          const statusColor = wallet.isBusy ? colors.yellow : colors.green;
          const statusText = wallet.isBusy ? 'BUSY' : 'FREE';
          console.log(
            `${statusColor}[${statusText}]${colors.reset} SOL: ${balances.sol.toFixed(6)}, USDC: ${balances.usdc.toFixed(2)}, USDT: ${balances.usdt.toFixed(2)}`
          );
        } else {
          console.log(`${colors.gray}Empty${colors.reset}`);
        }

        // Small delay to avoid rate limiting
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        console.log(`${colors.red}Error: ${err.message.substring(0, 50)}${colors.reset}`);
      }
    }

    console.log(`\n${colors.cyan}===============================================${colors.reset}`);
    console.log(`${colors.cyan}  Summary${colors.reset}`);
    console.log(`${colors.cyan}===============================================${colors.reset}`);
    console.log(`${colors.blue}Wallets with balance:${colors.reset} ${walletsWithBalance.length}`);
    console.log(`${colors.blue}Total SOL:${colors.reset} ${totalSol.toFixed(9)}`);
    console.log(`${colors.blue}Total USDC:${colors.reset} ${totalUsdc.toFixed(2)}`);
    console.log(`${colors.blue}Total USDT:${colors.reset} ${totalUsdt.toFixed(2)}\n`);

    if (walletsWithBalance.length > 0) {
      console.log(`${colors.yellow}Wallets with balances:${colors.reset}`);
      walletsWithBalance.forEach((w) => {
        const statusText = w.isBusy ? '🔒 BUSY' : '✅ FREE';
        console.log(`  ${statusText} ${w.address}`);
        console.log(
          `     SOL: ${w.balances.sol.toFixed(9)}, USDC: ${w.balances.usdc.toFixed(6)}, USDT: ${w.balances.usdt.toFixed(6)}`
        );
      });
      console.log();
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
