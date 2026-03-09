import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  SendTransactionError,
  SendOptions,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { TOKEN_MINTS } from './price';

export class TransactionService {
  private connection: Connection;
  private sendOptions: SendOptions;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.sendOptions = {
      skipPreflight: true,
      preflightCommitment: 'confirmed',
    };
  }

  /**
   * Transfer SOL or SPL token
   */
  async transfer(
    senderKeypair: Keypair,
    recipientPubkeyStr: string,
    amount: number,
    mintAddress: string,
    options: { priorityFee?: boolean } = { priorityFee: true }
  ): Promise<string> {
    const recipientPubkey = new PublicKey(recipientPubkeyStr);

    // Case 1: SOL Transfer
    if (mintAddress === TOKEN_MINTS.SOL) {
      return this.transferSol(senderKeypair, recipientPubkey, amount, options);
    }

    // Case 2: SPL Token Transfer (USDC, USDT)
    return this.transferSplToken(senderKeypair, recipientPubkey, amount, mintAddress, options);
  }

  /**
   * Batch Transfer SOL or SPL tokens
   */
  async batchTransfer(
    senderKeypair: Keypair,
    transfers: { recipient: string; amount: number }[],
    mintAddress: string,
    options: { priorityFee?: boolean } = { priorityFee: true }
  ): Promise<string> {
    const transaction = new Transaction();

    // Add priority fee to ensure transaction processing
    if (options.priorityFee) {
      transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
    }

    // Case 1: SOL Batch Transfer
    if (mintAddress === TOKEN_MINTS.SOL) {
      for (const t of transfers) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: new PublicKey(t.recipient),
            lamports: Math.round(t.amount * LAMPORTS_PER_SOL),
          })
        );
      }
      try {
        const signature = await this.connection.sendTransaction(
          transaction,
          [senderKeypair],
          this.sendOptions
        );
        const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
        if (confirmation.value.err) {
          throw new Error(`Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
        }
        return signature;
      } catch (error: any) {
        if (error instanceof SendTransactionError) {
          try {
            const logs = await error.getLogs(this.connection);
            console.error('[TransactionService] Transaction failed. Logs:', logs);
            throw new Error(`Transaction failed: ${logs?.join(' | ') || error.message}`);
          } catch {
            console.error('[TransactionService] Transaction failed:', error.message);
            throw new Error(`Transaction failed: ${error.message}`);
          }
        }
        throw error;
      }
    }

    // Case 2: SPL Token Batch Transfer (USDC/USDT)
    const mintPubkey = new PublicKey(mintAddress);
    const decimals = 6; // USDC/USDT

    // Get Sender ATA
    const senderAta = await getAssociatedTokenAddress(mintPubkey, senderKeypair.publicKey);

    // Get all recipient ATAs
    const recipientAtas = await Promise.all(
      transfers.map((t) => getAssociatedTokenAddress(mintPubkey, new PublicKey(t.recipient)))
    );

    // Check if ATAs exist
    const accountInfos = await this.connection.getMultipleAccountsInfo(recipientAtas);

    for (let i = 0; i < transfers.length; i++) {
      const transfer = transfers[i];
      const recipientAta = recipientAtas[i];
      const accountInfo = accountInfos[i];
      const recipientPubkey = new PublicKey(transfer.recipient);

      // If ATA doesn't exist, create it (payer = sender)
      if (!accountInfo) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            senderKeypair.publicKey,
            recipientAta,
            recipientPubkey,
            mintPubkey
          )
        );
      }

      // Add transfer instruction (6 decimals for USDC/USDT)
      const amountRaw = Math.round(transfer.amount * 1_000_000);
      transaction.add(
        createTransferInstruction(senderAta, recipientAta, senderKeypair.publicKey, amountRaw)
      );
    }

    try {
      const signature = await this.connection.sendTransaction(
        transaction,
        [senderKeypair],
        this.sendOptions
      );
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        throw new Error(`Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      return signature;
    } catch (error: any) {
      if (error instanceof SendTransactionError) {
        try {
          const logs = await error.getLogs(this.connection);
          console.error('[TransactionService] Transaction failed. Logs:', logs);
          throw new Error(`Transaction failed: ${logs?.join(' | ') || error.message}`);
        } catch {
          console.error('[TransactionService] Transaction failed:', error.message);
          throw new Error(`Transaction failed: ${error.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Transfer SOL
   */
  private async transferSol(
    senderKeypair: Keypair,
    recipientPubkey: PublicKey,
    amountSol: number,
    options: { priorityFee?: boolean } = { priorityFee: true }
  ): Promise<string> {
    const transaction = new Transaction();

    if (options.priorityFee) {
      transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
    }

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
      })
    );

    try {
      const signature = await this.connection.sendTransaction(
        transaction,
        [senderKeypair],
        this.sendOptions
      );
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        throw new Error(`Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      return signature;
    } catch (error: any) {
      if (error instanceof SendTransactionError) {
        try {
          const logs = await error.getLogs(this.connection);
          console.error('[TransactionService] Transaction failed. Logs:', logs);
          throw new Error(`Transaction failed: ${logs?.join(' | ') || error.message}`);
        } catch {
          console.error('[TransactionService] Transaction failed:', error.message);
          throw new Error(`Transaction failed: ${error.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Transfer SPL Token
   */
  private async transferSplToken(
    senderKeypair: Keypair,
    recipientPubkey: PublicKey,
    amountTokens: number,
    mintAddress: string,
    options: { priorityFee?: boolean } = { priorityFee: true }
  ): Promise<string> {
    const mintPubkey = new PublicKey(mintAddress);

    // Get ATAs (Associated Token Accounts)
    const senderAta = await getAssociatedTokenAddress(mintPubkey, senderKeypair.publicKey);
    const recipientAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

    const transaction = new Transaction();

    // Add priority fee to ensure transaction processing
    if (options.priorityFee) {
      transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
    }

    // Check if recipient has ATA, if not create it (funded by sender)
    try {
      await getAccount(this.connection, recipientAta);
    } catch {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          senderKeypair.publicKey, // Payer
          recipientAta,
          recipientPubkey,
          mintPubkey
        )
      );
    }

    // Add transfer instruction
    // Note: USDC/USDT have 6 decimals
    const decimals = 6;
    const amountRaw = Math.round(amountTokens * Math.pow(10, decimals));

    transaction.add(
      createTransferInstruction(senderAta, recipientAta, senderKeypair.publicKey, amountRaw)
    );

    try {
      const signature = await this.connection.sendTransaction(
        transaction,
        [senderKeypair],
        this.sendOptions
      );
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        throw new Error(`Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      return signature;
    } catch (error: any) {
      if (error instanceof SendTransactionError) {
        try {
          const logs = await error.getLogs(this.connection);
          console.error('[TransactionService] Transaction failed. Logs:', logs);
          throw new Error(`Transaction failed: ${logs?.join(' | ') || error.message}`);
        } catch {
          console.error('[TransactionService] Transaction failed:', error.message);
          throw new Error(`Transaction failed: ${error.message}`);
        }
      }
      throw error;
    }
  }
}
