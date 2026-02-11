async function testUltraGasless() {
  const inputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
  const outputMint = 'So11111111111111111111111111111111111111112'; // SOL
  const amount = '10000000'; // 10 USDC
  const taker = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'; // Example pubkey

  // Note: Using 'taker' instead of 'userPublicKey'
  const url = `https://lite-api.jup.ag/ultra/v1/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&taker=${taker}`;

  console.log('Fetching:', url);

  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Gasless:', data.gasless);
    console.log('Transaction present:', !!data.transaction);
    if (!data.transaction) {
      console.log('Full response:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

testUltraGasless();
