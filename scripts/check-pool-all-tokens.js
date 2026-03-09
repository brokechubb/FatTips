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

async function checkAllTokens(connection, walletPubkey) {
  const pubkey = new PublicKey(walletPubkey);
  
  // SOL balance
  const solBalance = await connection.getBalance(pubkey, 'confirmed');
  
  // Token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  });

  const tokens = [];
  tokenAccounts.value.forEach(account => {
    const info = account.account.data.parsed.info;
    const mint = info.mint;
    const amount = info.tokenAmount.uiAmount;
    if (amount > 0) {
      tokens.push({ mint, amount });
    }
  });

  return {
    sol: solBalance / 1e9,
    tokens
  };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const rpcUrl = process.env.SOLANA_RPC_URL;

  const pgClient = new Client({ connectionString: dbUrl });
  const connection = new Connection(rpcUrl, 'confirmed');

  try {
    await pgClient.connect();
    const result = await pgClient.query('SELECT address, "isBusy" FROM "AirdropPoolWallet"');
    const wallets = result.rows;

    console.log(`Checking ${wallets.length} pool wallets for ALL tokens...`);

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      try {
        const balances = await checkAllTokens(connection, wallet.address);
        
        if (balances.sol > 0.001 || balances.tokens.length > 0) {
          console.log(`Wallet ${wallet.address}:`);
          console.log(`  SOL: ${balances.sol}`);
          balances.tokens.forEach(t => {
            console.log(`  Token ${t.mint}: ${t.amount}`);
          });
        }
      } catch (err) {
        console.log(`Error checking ${wallet.address}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } finally {
    await pgClient.end();
  }
}

main();
