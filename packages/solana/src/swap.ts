import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionExpiredBlockheightExceededError,
} from '@solana/web3.js';
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

// Priority levels accepted by Jupiter's priorityLevelWithMaxLamports parameter.
// Escalated on each retry attempt to improve inclusion under congestion.
const PRIORITY_LEVELS = ['high', 'veryHigh'] as const;
const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000; // 0.001 SOL cap — reasonable ceiling for a swap

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

  async getSwapTransaction(
    quoteResponse: SwapQuote,
    userPublicKey: string,
    priorityLevel: string = 'high'
  ): Promise<string> {
    const response = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: MAX_PRIORITY_FEE_LAMPORTS,
            priorityLevel,
          },
        },
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

    // Check for error response format
    if (result.status === 'Failed' || result.error) {
      const errorCode = result.code || 'Unknown';
      throw new Error(`Temporary Error (${errorCode}): Swap failed, please try again.`);
    }

    // Ultra API returns { txid: "signature" } on success
    const txSignature = result.txid || result.signature;

    if (!txSignature || typeof txSignature !== 'string') {
      console.warn('Unknown Ultra API execute response format:', result);
      throw new Error('Gasless swap failed: no transaction signature returned.');
    }

    // Confirm transaction actually landed on-chain
    const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
    const confirmation = await this.connection.confirmTransaction(
      {
        signature: txSignature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed'
    );

    if (confirmation.value.err) {
      throw new Error(
        `Gasless swap transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    return txSignature;
  }

  async executeSwap(
    userKeypair: Keypair,
    quoteResponse: SwapQuote,
    initialSwapTransactionBase64?: string
  ): Promise<string> {
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Fetch fresh transaction with escalated priority level on retries
      let swapTransactionBase64: string;
      if (attempt === 0 && initialSwapTransactionBase64) {
        swapTransactionBase64 = initialSwapTransactionBase64;
      } else {
        const level = PRIORITY_LEVELS[Math.min(attempt, PRIORITY_LEVELS.length - 1)];
        console.log(
          `[JupiterSwapService] Retry ${attempt + 1}/${maxRetries}: fetching fresh tx with priority "${level}"`
        );
        swapTransactionBase64 = await this.getSwapTransaction(
          quoteResponse,
          userKeypair.publicKey.toBase58(),
          level
        );
      }

      // Deserialize the transaction
      const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      // Validate the transaction before signing
      const message = transaction.message;
      const userKeyStr = userKeypair.publicKey.toBase58();

      let userIsRequiredSigner = false;
      for (let i = 0; i < message.header.numRequiredSignatures; i++) {
        if (message.staticAccountKeys[i]?.toBase58() === userKeyStr) {
          userIsRequiredSigner = true;
          break;
        }
      }
      if (!userIsRequiredSigner) {
        throw new Error(
          'Swap transaction validation failed: user wallet is not a required signer. ' +
            'This may indicate a tampered transaction.'
        );
      }

      const instructionCount = message.compiledInstructions.length;
      if (instructionCount > 30) {
        throw new Error(
          `Swap transaction validation failed: suspicious instruction count (${instructionCount}). ` +
            'Normal swaps have fewer instructions.'
        );
      }

      // Sign the transaction
      transaction.sign([userKeypair]);

      // Get fresh blockhash for each attempt
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

      // Send the transaction
      const signature = await this.connection.sendTransaction(transaction, {
        skipPreflight: true,
        maxRetries: 2,
      });

      try {
        // Confirm transaction and check for errors
        const confirmation = await this.connection.confirmTransaction(
          {
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          },
          'confirmed'
        );

        if (confirmation.value.err) {
          throw new Error(
            `Swap transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
          );
        }

        return signature;
      } catch (error: unknown) {
        // Blockhash expired — check if tx actually landed before retrying
        if (error instanceof TransactionExpiredBlockheightExceededError) {
          const landed = await this.checkTransactionLanded(signature);
          if (landed) {
            return landed;
          }

          if (attempt < maxRetries - 1) {
            continue; // Retry with fresh blockhash + escalated fee
          }

          throw new Error(
            'The Solana network is currently congested and could not process this swap in time. Please try again in a moment.'
          );
        }

        // Re-throw non-expiry errors immediately
        throw error;
      }
    }

    throw new Error('Swap failed after multiple attempts. Please try again.');
  }

  private async checkTransactionLanded(signature: string): Promise<string | null> {
    const status = await this.connection.getSignatureStatus(signature);
    if (status.value && !status.value.err) {
      return signature;
    }
    return null;
  }
}
