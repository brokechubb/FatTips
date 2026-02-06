import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
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

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  /**
   * Transfer SOL or SPL token
   */
  async transfer(
    senderKeypair: Keypair,
    recipientPubkeyStr: string,
    amount: number,
    mintAddress: string
  ): Promise<string> {
    const recipientPubkey = new PublicKey(recipientPubkeyStr);

    // Case 1: SOL Transfer
    if (mintAddress === TOKEN_MINTS.SOL) {
      return this.transferSol(senderKeypair, recipientPubkey, amount);
    }

    // Case 2: SPL Token Transfer (USDC, USDT)
    return this.transferSplToken(senderKeypair, recipientPubkey, amount, mintAddress);
  }

  /**
   * Transfer SOL
   */
  private async transferSol(
    senderKeypair: Keypair,
    recipientPubkey: PublicKey,
    amountSol: number
  ): Promise<string> {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
      })
    );

    return sendAndConfirmTransaction(this.connection, transaction, [senderKeypair]);
  }

  /**
   * Transfer SPL Token
   */
  private async transferSplToken(
    senderKeypair: Keypair,
    recipientPubkey: PublicKey,
    amountTokens: number,
    mintAddress: string
  ): Promise<string> {
    const mintPubkey = new PublicKey(mintAddress);

    // Get ATAs (Associated Token Accounts)
    const senderAta = await getAssociatedTokenAddress(mintPubkey, senderKeypair.publicKey);
    const recipientAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

    const transaction = new Transaction();

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

    return sendAndConfirmTransaction(this.connection, transaction, [senderKeypair]);
  }
}
