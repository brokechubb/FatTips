#!/usr/bin/env node
/**
 * Check specific airdrop wallet records
 */

const { Client } = require('pg');

const dbUrl = process.env.DATABASE_URL;

async function main() {
  const pgClient = new Client({ connectionString: dbUrl });

  try {
    await pgClient.connect();

    console.log('🔍 Checking Specific Airdrop Records\n');
    console.log('='.repeat(80));

    // Check the two wallets in question
    const wallets = [
      'REDACTED_POOL_WALLET',
      'REDACTED_POOL_WALLET',
    ];

    for (const wallet of wallets) {
      console.log(`\n📋 Wallet: ${wallet}`);
      console.log('-'.repeat(80));

      // Get ALL airdrops for this wallet
      const airdrops = await pgClient.query(
        `
        SELECT 
          a.id,
          a.status,
          a."creatorId",
          a."amountTotal",
          a."createdAt",
          u."walletPubkey" as "creatorWallet",
          u."discordId" as "creatorDiscordId"
        FROM "Airdrop" a
        LEFT JOIN "User" u ON a."creatorId" = u."discordId"
        WHERE a."walletPubkey" = $1
        ORDER BY a."createdAt" DESC
      `,
        [wallet]
      );

      console.log(`  Found ${airdrops.rows.length} airdrop(s) for this wallet:\n`);

      for (const airdrop of airdrops.rows) {
        console.log(`  Airdrop ID: ${airdrop.id}`);
        console.log(`  Status: ${airdrop.status}`);
        console.log(`  Creator Discord ID: ${airdrop.creatorId}`);
        console.log(`  Creator Wallet: ${airdrop.creatorWallet || 'NOT FOUND'}`);
        console.log(`  Amount: ${airdrop.amountTotal} SOL`);
        console.log(`  Created: ${airdrop.createdAt}`);
        console.log();
      }

      // Check pool wallet record
      const poolWallet = await pgClient.query(
        `
        SELECT 
          address,
          "isBusy",
          "lastUsedAt"
        FROM "AirdropPoolWallet"
        WHERE address = $1
      `,
        [wallet]
      );

      if (poolWallet.rows.length > 0) {
        console.log(`  Pool Wallet Status:`);
        console.log(`    isBusy: ${poolWallet.rows[0].isBusy}`);
        console.log(`    lastUsedAt: ${poolWallet.rows[0].lastUsedAt}`);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('\n⚠️  ANALYSIS:');
    console.log('If the Creator Discord ID does NOT match REDACTED_DISCORD_ID,');
    console.log('then the funds were sent to the wrong person!');
    console.log('\n🚨 To recover YOUR funds, we need to:');
    console.log('1. Find which airdrops YOU actually created');
    console.log('2. Check if those wallets still have funds');
    console.log('3. Send funds to YOUR wallet (not the database creator)');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pgClient.end();
  }
}

main();
