#!/usr/bin/env node
/**
 * Check if recipient wallets are in FatTips system
 */

const { Client } = require('pg');

const dbUrl = process.env.DATABASE_URL;

// The wallets that received your funds
const RECIPIENT_WALLETS = [
  'AmCvT2yQbp3Xak8wnVpQsLqE59ua5YHA84S7BD9zroBc', // Received 0.097494 SOL
  '7hCWkG1xqqJ7ryhQfTmeLUQm929ttLnqHPR5G8AA9Zsn', // Received 0.097468 SOL
];

async function main() {
  const pgClient = new Client({ connectionString: dbUrl });

  try {
    await pgClient.connect();

    console.log('🔍 Checking if recipient wallets are in FatTips system\n');
    console.log('='.repeat(80));

    for (const wallet of RECIPIENT_WALLETS) {
      console.log(`\n📋 Wallet: ${wallet}`);
      console.log('-'.repeat(80));

      // Check if this is a FatTips user wallet
      const userResult = await pgClient.query(
        `
        SELECT 
          "discordId",
          "encryptedPrivkey",
          "keySalt",
          "walletPubkey"
        FROM "User"
        WHERE "walletPubkey" = $1
      `,
        [wallet]
      );

      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        console.log('✅ FOUND in FatTips system!');
        console.log(`   Discord ID: ${user.discordId}`);
        console.log(`   Has Encrypted Key: ${user.encryptedPrivkey ? 'YES' : 'NO'}`);
        console.log(`   Has Key Salt: ${user.keySalt ? 'YES' : 'NO'}`);

        if (user.encryptedPrivkey && user.keySalt) {
          console.log("\n   🚨 IMPORTANT: This user's private key is in the database!");
          console.log('   Theoretically, we could recover the funds if we had permission...');
        }
      } else {
        console.log('❌ NOT FOUND in FatTips system');
        console.log("   This is an external wallet - cannot access without owner's permission");
      }

      // Also check if it's a pool wallet
      const poolResult = await pgClient.query(
        `
        SELECT address, "isBusy"
        FROM "AirdropPoolWallet"
        WHERE address = $1
      `,
        [wallet]
      );

      if (poolResult.rows.length > 0) {
        console.log('\n   ℹ️ This is also a pool wallet');
        console.log(`   isBusy: ${poolResult.rows[0].isBusy}`);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('\n📊 CONCLUSION:');
    console.log('If the wallets are in the FatTips system, we have their encrypted keys.');
    console.log("However, accessing another user's wallet without permission would be:");
    console.log('1. A violation of trust');
    console.log('2. Potentially illegal (unauthorized access)');
    console.log('3. Wrong from a security standpoint');
    console.log('\n💡 RECOMMENDATION:');
    console.log('Contact the users and ask them to return the funds voluntarily.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pgClient.end();
  }
}

main();
