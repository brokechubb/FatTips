const { Client } = require('pg');
const { Connection, PublicKey } = require('@solana/web3.js');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const rpcUrl = process.env.SOLANA_RPC_URL;

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');

  try {
    await pgClient.connect();
    const result = await pgClient.query('SELECT "discordId", "walletPubkey" FROM "User"');
    const users = result.rows;

    console.log(`Checking ${users.length} users...`);
    const balances = [];

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      try {
        const bal = await connection.getBalance(new PublicKey(user.walletPubkey), 'confirmed');
        if (bal > 0) {
          balances.push({
            discordId: user.discordId,
            address: user.walletPubkey,
            sol: bal / 1e9
          });
        }
      } catch (err) {}
      await new Promise(r => setTimeout(r, 50));
    }

    balances.sort((a, b) => b.sol - a.sol);
    process.stdout.write('\nTop funded user wallets:\n');
    balances.forEach(b => {
      process.stdout.write(`${b.discordId} (${b.address}): ${b.sol.toFixed(9)} SOL\n`);
    });

  } finally {
    await pgClient.end();
  }
}

main();
