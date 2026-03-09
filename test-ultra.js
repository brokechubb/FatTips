const { Keypair, PublicKey, Connection } = require('@solana/web3.js');

async function testUltraGasless() {
  const inputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
  const outputMint = 'So11111111111111111111111111111111111111112'; // SOL
  const amount = '10000000'; // 10 USDC

  // We need a real public key to test "insufficient SOL" behavior,
  // but for now let's just see if we get a valid response with 'taker' param.
  const taker = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'; // Example pubkey

  const url = `https://lite-api.jup.ag/ultra/v1/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&taker=${taker}`;

  console.log('Fetching:', url);

  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Gasless:', data.gasless);
    console.log('Transaction present:', !!data.transaction);
    if (!data.transaction) {
      console.log('Error Code:', data.errorCode);
      console.log('Error Message:', data.errorMessage);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

testUltraGasless();
