const { Keypair } = require('@solana/web3.js');

async function testGasless() {
  const inputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
  const outputMint = 'So11111111111111111111111111111111111111112'; // SOL
  const amount = '1000000'; // 1 USDC
  const userPublicKey = Keypair.generate().publicKey.toString();

  const url = `https://lite-api.jup.ag/ultra/v1/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&userPublicKey=${userPublicKey}&gasless=true`;

  console.log('Fetching:', url);

  try {
    const response = await fetch(url);
    const text = await response.text();
    console.log('Status:', response.status);
    console.log('Response:', text);
  } catch (error) {
    console.error('Error:', error);
  }
}

testGasless();
