#!/usr/bin/env node
/**
 * Check Pool Wallet Balances (SOL only version)
 *
 * This script checks all airdrop pool wallets to see if any have SOL balances
 * from failed airdrops or incomplete settlements.
 *
 * Note: This simplified version only checks SOL balance since @solana/spl-token
 * is not available in the production container.
 *
 * Usage:
 *   node check-pool-balances-simple.js [DATABASE_URL] [SOLANA_RPC_URL]
 */

const { Client } = require('pg');
const { Connection, PublicKey } = require('@solana/web3.js');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

async function main() {
  const [, , dbUrl, rpcUrl] = process.argv;

  if (!dbUrl || !rpcUrl) {
    console.log('Usage: node check-pool-balances-simple.js <DATABASE_URL> <RPC_URL>');
    console.log('Example: node check-pool-balances-simple.js postgresql://... https://...');
    process.exit(1);
  }

  console.log(`${colors.cyan}===============================================${colors.reset}`);
  console.log(`${colors.cyan}  Pool Wallet Balance Check (SOL Only)${colors.reset}`);
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

    for (let i = 0; i < poolWallets.length; i++) {
      const wallet = poolWallets[i];
      process.stdout.write(
        `[${i + 1}/${poolWallets.length}] ${wallet.address.substring(0, 20)}... `
      );

      try {
        const pubkey = new PublicKey(wallet.address);
        const solBalanceLamports = await connection.getBalance(pubkey, 'confirmed');
        const solBalance = solBalanceLamports / 1e9;

        // Consider non-zero if more than 0.001 SOL (dust threshold)
        if (solBalance > 0.001) {
          walletsWithBalance.push({
            address: wallet.address,
            isBusy: wallet.isBusy,
            solBalance,
          });
          totalSol += solBalance;

          const statusColor = wallet.isBusy ? colors.yellow : colors.green;
          const statusText = wallet.isBusy ? 'BUSY' : 'FREE';
          console.log(`${statusColor}[${statusText}]${colors.reset} SOL: ${solBalance.toFixed(9)}`);
        } else {
          console.log(`${colors.gray}Empty (${solBalance.toFixed(9)} SOL)${colors.reset}`);
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
    console.log(`${colors.blue}Total SOL:${colors.reset} ${totalSol.toFixed(9)}\n`);

    if (walletsWithBalance.length > 0) {
      console.log(`${colors.yellow}Wallets with SOL balances:${colors.reset}`);
      walletsWithBalance.forEach((w) => {
        const statusText = w.isBusy ? '🔒 BUSY' : '✅ FREE';
        console.log(`  ${statusText} ${w.address}`);
        console.log(`     SOL: ${w.solBalance.toFixed(9)}`);
      });
      console.log();

      console.log(`${colors.yellow}Note: This script only checks SOL balances.${colors.reset}`);
      console.log(
        `${colors.yellow}Token balances (USDC/USDT) are not checked in this environment.${colors.reset}\n`
      );
    } else {
      console.log(
        `${colors.green}✅ All pool wallets are empty (or contain only dust amounts).${colors.reset}\n`
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
