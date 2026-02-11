import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_MINTS } from './price';

export interface SwapQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee?: { amount: string; feeBps: number };
  priceImpactPct: string;
  routePlan: any[];
  contextSlot?: number;
  timeTaken?: number;
  requestId?: string; // For Ultra API
}

export class JupiterSwapService {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl);
  }

  getDecimals(mint: string): number {
    if (mint === TOKEN_MINTS.SOL) return 9;
    if (mint === TOKEN_MINTS.USDC) return 6;
    if (mint === TOKEN_MINTS.USDT) return 6;
    return 9;
  }

  getTokenSymbol(mint: string): string {
    if (mint === TOKEN_MINTS.SOL) return 'SOL';
    if (mint === TOKEN_MINTS.USDC) return 'USDC';
    if (mint === TOKEN_MINTS.USDT) return 'USDT';
    return 'UNKNOWN';
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50 // 0.5%
  ): Promise<SwapQuote> {
    const decimals = this.getDecimals(inputMint);
    const amountAtomic = Math.floor(amount * Math.pow(10, decimals));

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountAtomic.toString(),
      slippageBps: slippageBps.toString(),
    });

    const response = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params.toString()}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Quote failed: ${response.statusText} - ${errorText}`);
    }

    return (await response.json()) as SwapQuote;
  }

  async getSwapTransaction(quoteResponse: SwapQuote, userPublicKey: string): Promise<string> {
    const response = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true, // Prioritize inclusion
        prioritizationFeeLamports: 'auto', // Use auto priority fee
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Swap transaction failed: ${response.statusText} - ${errorText}`);
    }

    const { swapTransaction } = (await response.json()) as { swapTransaction: string };
    return swapTransaction;
  }

  async getGaslessSwap(
    inputMint: string,
    outputMint: string,
    amount: number,
    userPublicKey: string
  ): Promise<{ transaction: string; quote: any }> {
    const decimals = this.getDecimals(inputMint);
    const amountAtomic = Math.floor(amount * Math.pow(10, decimals));

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountAtomic.toString(),
      taker: userPublicKey, // Correct parameter for Ultra API is 'taker'
    });

    const response = await fetch(`https://lite-api.jup.ag/ultra/v1/order?${params.toString()}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gasless swap failed: ${response.statusText} - ${errorText}`);
    }

    const data = (await response.json()) as any;

    if (!data.transaction) {
      // Check for specific error codes from Ultra API
      if (data.errorCode) {
        throw new Error(
          `Ultra API Error ${data.errorCode}: ${data.errorMessage || 'Unknown error'}`
        );
      }
      throw new Error(
        'Gasless swap unavailable for this pair or amount (No transaction returned). Try increasing amount or using standard swap.'
      );
    }

    return { transaction: data.transaction, quote: data };
  }

  async executeGaslessSwap(
    userKeypair: Keypair,
    transactionBase64: string,
    requestId: string
  ): Promise<string> {
    // 1. Deserialize
    const transactionBuf = Buffer.from(transactionBase64, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuf);

    // 2. Sign
    transaction.sign([userKeypair]);

    // 3. Serialize Signed Transaction
    const signedTransactionBase64 = Buffer.from(transaction.serialize()).toString('base64');

    // 4. Submit to Ultra API
    const response = await fetch('https://lite-api.jup.ag/ultra/v1/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        signedTransaction: signedTransactionBase64,
        requestId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gasless execution failed: ${response.statusText} - ${errorText}`);
    }

    const result = (await response.json()) as any;

    // Ultra API returns { txid: "signature" } on success
    if (result.txid) {
      return result.txid;
    }

    if (result.signature) {
      return result.signature;
    }

    // Check for error response format
    if (result.status === 'Failed' || result.error) {
      const errorCode = result.code || 'Unknown';
      throw new Error(`Temporary Error (${errorCode}): Swap failed, please try again.`);
    }

    // Fallback
    console.warn('Unknown Ultra API execute response format:', result);
    return (
      result.txid ||
      result.signature ||
      (typeof result === 'string' ? result : JSON.stringify(result))
    );
  }

  async executeSwap(userKeypair: Keypair, swapTransactionBase64: string): Promise<string> {
    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Sign the transaction
    transaction.sign([userKeypair]);

    // Send the transaction
    const signature = await this.connection.sendTransaction(transaction, {
      skipPreflight: true,
      maxRetries: 2,
    });

    // Confirm transaction
    const latestBlockhash = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed'
    );

    return signature;
  }
}
