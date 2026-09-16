import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  SendTransactionError,
  SendOptions,
  TransactionExpiredTimeoutError,
  TransactionExpiredBlockheightExceededError,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { TOKEN_MINTS } from './price';

// Priority fee constants
// Static fallback used when dynamic fee estimation fails.
const PRIORITY_FEE_FALLBACK_MICRO_LAMPORTS = 100_000; // 0.1 lamports/CU — conservative baseline
// Fee is escalated on each retry attempt to improve inclusion odds under congestion.
const PRIORITY_FEE_ESCALATION_MULTIPLIER = 3; // each retry multiplies fee by this factor
const PRIORITY_FEE_CAP_MICRO_LAMPORTS = 5_000_000; // ~$0.05 max per tip — reasonable ceiling

// Compute unit estimates with generous 3x safety margin.
// If the limit is too tight, validators silently drop the transaction.
const CU_PER_SOL_TRANSFER = 1_500; // actual ~450, padded for safety
const CU_PER_SPL_TRANSFER = 15_000; // actual ~4k, padded for safety
const CU_PER_ATA_CREATION = 50_000; // actual ~25-30k, padded for safety
const CU_OVERHEAD = 2_000; // ComputeBudget instructions + signature verification

// Cap each confirmation wait at this duration instead of the full blockhash expiry
// (~45s). When it elapses, check on-chain status, re-propagate if the blockhash is
// still valid, and only escalate to a fresh-blockhash retry once provably expired.
const CONFIRM_SOFT_TIMEOUT_MS = 15_000;
// Total wall-clock budget for one attempt's confirmation (re-propagate + re-wait
// cycles included). Keeps worst-case per-attempt latency bounded at ~30s instead
// of the ~50s full blockhash-expiry wait users were seeing.
const CONFIRM_SOFT_TOTAL_MS = 30_000;

/**
 * Thrown when the soft confirmation window elapses without the transaction
 * reaching 'confirmed'. Never indicates the transaction executed.
 */
class SoftConfirmationTimeoutError extends Error {
  constructor() {
    super('Confirmation soft timeout elapsed');
    this.name = 'SoftConfirmationTimeoutError';
  }
}

export class TransactionService {
  private connection: Connection;
  private rpcUrl: string;
  private sendOptions: SendOptions;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.sendOptions = {
      skipPreflight: true,
      preflightCommitment: 'confirmed',
      maxRetries: 0, // Disable RPC internal retries — we manage retries ourselves
    };
  }

  /**
   * Fetch a dynamic priority fee from the Helius getPriorityFeeEstimate API.
   * Uses the 'high' fee level — 'recommended' underestimates during congestion,
   * which causes transactions to be dropped by validators and only recover after
   * a full blockhash-expiry wait (~50s). 'high' costs fractions of a cent more
   * for typical transfers and avoids most drops.
   * Falls back to PRIORITY_FEE_FALLBACK_MICRO_LAMPORTS if the RPC doesn't support it.
   *
   * On retry attempts the fee is escalated by PRIORITY_FEE_ESCALATION_MULTIPLIER to
   * improve inclusion odds under congestion, capped at PRIORITY_FEE_CAP_MICRO_LAMPORTS.
   */
  private async getDynamicPriorityFee(attempt: number = 0): Promise<number> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'getPriorityFeeEstimate',
          params: [{ options: { includeAllPriorityFeeLevels: true } }],
        }),
      });
      const data = (await response.json()) as {
        result?: {
          priorityFeeEstimate?: number;
          priorityFeeLevels?: { low?: number; medium?: number; high?: number };
        };
        error?: unknown;
      };
      const levels = data?.result?.priorityFeeLevels;
      // Prefer 'high', falling down the ladder if a level is missing
      const base = levels?.high ?? levels?.medium ?? levels?.low ?? data?.result?.priorityFeeEstimate;
      if (base != null) {
        // Escalate on retries: attempt 0 = base fee, attempt 1 = base*3, attempt 2 = base*9, etc.
        const escalated = Math.round(base * Math.pow(PRIORITY_FEE_ESCALATION_MULTIPLIER, attempt));
        const capped = Math.min(escalated, PRIORITY_FEE_CAP_MICRO_LAMPORTS);
        if (attempt > 0) {
          console.log(
            `[TransactionService] Dynamic priority fee: ${base} → ${capped} microLamports (attempt ${attempt + 1}, escalation ${PRIORITY_FEE_ESCALATION_MULTIPLIER}x)`
          );
        }
        return capped;
      }
    } catch (err) {
      console.warn(
        '[TransactionService] Failed to fetch dynamic priority fee, using fallback:',
        err
      );
    }
    // Fallback: also escalate the static fallback on retries
    const escalated = Math.round(
      PRIORITY_FEE_FALLBACK_MICRO_LAMPORTS * Math.pow(PRIORITY_FEE_ESCALATION_MULTIPLIER, attempt)
    );
    return Math.min(escalated, PRIORITY_FEE_CAP_MICRO_LAMPORTS);
  }

  /**
   * Transfer SOL or SPL token
   */
  async transfer(
    senderKeypair: Keypair,
    recipientPubkeyStr: string,
    amount: number,
    mintAddress: string,
    options: { priorityFee?: boolean; onRetry?: (attempt: number) => void } = { priorityFee: true }
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
    options: { priorityFee?: boolean; onRetry?: (attempt: number) => void } = { priorityFee: true }
  ): Promise<string> {
    const transaction = new Transaction();

    // Case 1: SOL Batch Transfer
    if (mintAddress === TOKEN_MINTS.SOL) {
      const cuLimit = Math.min(transfers.length * CU_PER_SOL_TRANSFER + CU_OVERHEAD, 1_400_000);
      for (const t of transfers) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: new PublicKey(t.recipient),
            lamports: Math.round(t.amount * LAMPORTS_PER_SOL),
          })
        );
      }
      return this.sendAndConfirm(
        transaction,
        [senderKeypair],
        undefined,
        options.priorityFee ? cuLimit : undefined,
        options.onRetry
      );
    }

    // Case 2: SPL Token Batch Transfer (USDC/USDT)
    const mintPubkey = new PublicKey(mintAddress);

    // Get Sender ATA
    const senderAta = await getAssociatedTokenAddress(mintPubkey, senderKeypair.publicKey);

    // Get all recipient ATAs
    const recipientAtas = await Promise.all(
      transfers.map((t) => getAssociatedTokenAddress(mintPubkey, new PublicKey(t.recipient)))
    );

    // Check if ATAs exist
    const accountInfos = await this.connection.getMultipleAccountsInfo(recipientAtas);

    let newAtaCount = 0;
    for (let i = 0; i < transfers.length; i++) {
      const transfer = transfers[i];
      const recipientAta = recipientAtas[i];
      const accountInfo = accountInfos[i];
      const recipientPubkey = new PublicKey(transfer.recipient);

      // If ATA doesn't exist, create it (payer = sender)
      if (!accountInfo) {
        newAtaCount++;
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

    const cuLimit = Math.min(
      newAtaCount * CU_PER_ATA_CREATION + transfers.length * CU_PER_SPL_TRANSFER + CU_OVERHEAD,
      1_400_000
    );
    return this.sendAndConfirm(
      transaction,
      [senderKeypair],
      undefined,
      options.priorityFee ? cuLimit : undefined,
      options.onRetry
    );
  }

  /**
   * Check if a transaction actually landed on-chain by querying its signature status.
   * Returns the signature if confirmed/finalized, null otherwise.
   */
  private async checkTransactionLanded(signature: string): Promise<string | null> {
    try {
      const status = await this.connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      if (
        status.value !== null &&
        status.value.err === null &&
        (status.value.confirmationStatus === 'confirmed' ||
          status.value.confirmationStatus === 'finalized')
      ) {
        return signature;
      }
      // Transaction landed but failed on-chain
      if (status.value !== null && status.value.err !== null) {
        throw new Error(
          `Transaction confirmed but failed on-chain: ${JSON.stringify(status.value.err)}`
        );
      }
    } catch (error: unknown) {
      // Re-throw on-chain failure errors
      if (error instanceof Error && error.message.startsWith('Transaction confirmed but failed')) {
        throw error;
      }
      // Swallow RPC errors during status check — we'll retry
      console.warn(`[TransactionService] Status check failed for ${signature}:`, error);
    }
    return null;
  }

  /**
   * Wait for confirmation with a soft timeout. Instead of waiting the full
   * blockhash expiry (~45s) before giving up, we:
   *   1. Wait up to CONFIRM_SOFT_TIMEOUT_MS for confirmation
   *   2. Check if the tx landed anyway (RPC lag) — if so, done
   *   3. If the blockhash is still valid, re-propagate the signed transaction
   *      (idempotent — same signature cannot execute twice) and keep waiting
   *   4. Once the total soft budget is exhausted — or the blockhash has
   *      provably expired — throw TransactionExpiredBlockheightExceededError.
   *      Either way the caller's fresh-blockhash retry is safe and cannot
   *      double-send: the original signature never executed.
   */
  private async confirmWithSoftTimeout(
    signature: string,
    rawTransaction: Uint8Array,
    blockhash: string,
    lastValidBlockHeight: number
  ): Promise<void> {
    const softBudgetEnd = Date.now() + CONFIRM_SOFT_TOTAL_MS;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const confirmPromise = this.connection
        .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
        .then((confirmation) => {
          // confirmTransaction RESOLVES (doesn't throw) when the tx executes
          // and fails on-chain — surface that as a real error
          if (confirmation.value.err) {
            throw new Error(
              `Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`
            );
          }
        });
      // If the timer wins the race, the confirm promise may still reject later
      // (e.g. blockhash expiry) — swallow it so it can't crash the process as
      // an unhandled rejection
      confirmPromise.catch(() => {});
      try {
        await Promise.race([
          confirmPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new SoftConfirmationTimeoutError()),
              CONFIRM_SOFT_TIMEOUT_MS
            );
          }),
        ]);
        return; // confirmed successfully
      } catch (error: unknown) {
        if (error instanceof SoftConfirmationTimeoutError) {
          // Window elapsed — check if it landed anyway before re-propagating
          const landed = await this.checkTransactionLanded(signature);
          if (landed) {
            console.warn(`[TransactionService] Confirmation slow but tx landed: ${signature}`);
            return;
          }

          // Blockhash provably expired → fresh-blockhash retry is safe
          const currentHeight = await this.connection.getBlockHeight('confirmed');
          if (currentHeight > lastValidBlockHeight) {
            throw new TransactionExpiredBlockheightExceededError(signature);
          }

          // Soft budget exhausted → give up on this signature; it never executed,
          // so the caller's fresh-blockhash retry cannot double-send
          if (Date.now() >= softBudgetEnd) {
            console.warn(
              `[TransactionService] Confirmation not received within soft budget for ${signature} (still within blockhash validity)`
            );
            throw new TransactionExpiredBlockheightExceededError(signature);
          }

          // Still valid with budget left — re-send the exact same signed
          // transaction (idempotent) and keep waiting. Re-propagation errors
          // (e.g. "already processed") are non-fatal: the original tx is
          // still in flight, so keep waiting rather than failing the job.
          console.warn(
            `[TransactionService] Confirmation slow (${signature.slice(0, 16)}…), re-propagating transaction...`
          );
          try {
            await this.connection.sendRawTransaction(rawTransaction, {
              skipPreflight: true,
              maxRetries: 5,
            });
          } catch (reErr: unknown) {
            console.warn(`[TransactionService] Re-propagation failed (non-fatal):`, reErr);
          }
          continue;
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  /**
   * Send a transaction and confirm using the blockhash-based strategy.
   * Fetches a dynamic priority fee each attempt and escalates on retries.
   * Retries with fresh blockhash on expiry errors. Checks on-chain status
   * before retrying to avoid duplicate sends.
   *
   * @param transaction  The transaction to send. ComputeBudget instructions will
   *                     be prepended automatically on each attempt if cuLimit is set.
   * @param signers      Keypairs to sign with.
   * @param maxRetries   Max attempts (default 5).
   * @param cuLimit      If provided, dynamic priority fee + CU limit instructions
   *                     are prepended to the transaction on each attempt.
   *                     Pass undefined to skip fee injection (e.g. skipPriorityFee paths).
   */
  private async sendAndConfirm(
    transaction: Transaction,
    signers: Keypair[],
    maxRetries = 2,
    cuLimit?: number,
    onRetry?: (attempt: number) => void
  ): Promise<string> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Fetch dynamic priority fee for this attempt (escalates on retries)
      if (cuLimit !== undefined) {
        const priorityFee = await this.getDynamicPriorityFee(attempt);
        // Remove any existing ComputeBudget instructions from a prior attempt
        transaction.instructions = transaction.instructions.filter(
          (ix) => !ix.programId.equals(ComputeBudgetProgram.programId)
        );
        // Prepend fresh CU limit + price instructions
        transaction.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
        );
      }

      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = signers[0].publicKey;

      // First attempt: use preflight to catch simulation errors (insufficient balance, etc.)
      // Retries: skip preflight since we already know the tx structure is valid
      const opts = attempt === 0 ? { ...this.sendOptions, skipPreflight: false } : this.sendOptions;

      // Sign explicitly so we can serialize the signed tx for idempotent
      // re-propagation inside confirmWithSoftTimeout
      transaction.sign(...signers);
      const rawTransaction = transaction.serialize();
      const signature = await this.connection.sendRawTransaction(rawTransaction, opts);
      try {
        // Soft-timeout confirmation: re-propagates while the blockhash is valid,
        // escalates to a fresh-blockhash retry as soon as it provably expires.
        await this.confirmWithSoftTimeout(signature, rawTransaction, blockhash, lastValidBlockHeight);
        return signature;
      } catch (error: unknown) {
        lastError = error;

        // Blockhash expired or confirmation timed out — check if tx actually landed
        if (
          error instanceof TransactionExpiredBlockheightExceededError ||
          error instanceof TransactionExpiredTimeoutError
        ) {
          const errorType =
            error instanceof TransactionExpiredBlockheightExceededError
              ? 'block height exceeded'
              : 'timeout';
          console.warn(
            `[TransactionService] Confirmation ${errorType} for ${signature} (attempt ${attempt + 1}/${maxRetries})`
          );

          const landed = await this.checkTransactionLanded(signature);
          if (landed) {
            console.warn(
              `[TransactionService] Confirmation ${errorType} but tx landed: ${signature}`
            );
            return landed;
          }

          // Transaction didn't land — retry with fresh blockhash if we have attempts left
          if (attempt < maxRetries - 1) {
            console.warn(
              `[TransactionService] Transaction not found on-chain, retrying with fresh blockhash...`
            );
            onRetry?.(attempt + 1);
            continue;
          }

          // Final attempt exhausted — throw user-friendly congestion error
          throw new Error(
            'The Solana network is currently congested and could not process this transaction in time. Please try again in a moment.'
          );
        }

        // SendTransactionError — extract logs and throw immediately (no retry)
        if (error instanceof SendTransactionError) {
          try {
            const logs = await error.getLogs(this.connection);
            console.error('[TransactionService] Transaction failed. Logs:', logs);
            throw new Error(`Transaction failed: ${logs?.join(' | ') || (error as Error).message}`);
          } catch (inner: unknown) {
            if (inner instanceof Error && inner.message.startsWith('Transaction failed:')) {
              throw inner;
            }
            throw error;
          }
        }

        // Transient RPC error (e.g. Helius "Internal error", -32603) — retry with fresh blockhash
        const isRpcError =
          error instanceof Error &&
          (error.message.includes('Internal error') ||
            error.message.includes('failed to get signature status') ||
            (error as any).code === -32603 ||
            (error as any).code === -32000);
        if (isRpcError && attempt < maxRetries - 1) {
          console.warn(
            `[TransactionService] Transient RPC error on attempt ${attempt + 1}/${maxRetries}, retrying: ${(error as Error).message}`
          );
          await new Promise((r) => setTimeout(r, 2_000));
          onRetry?.(attempt + 1);
          continue;
        }

        // Unknown error — throw immediately
        throw error;
      }
    }

    // Should not reach here, but safety net
    throw lastError ?? new Error(`Transaction failed after ${maxRetries} attempts`);
  }

  /**
   * Transfer SOL
   */
  private async transferSol(
    senderKeypair: Keypair,
    recipientPubkey: PublicKey,
    amountSol: number,
    options: { priorityFee?: boolean; onRetry?: (attempt: number) => void } = { priorityFee: true }
  ): Promise<string> {
    const transaction = new Transaction();
    const cuLimit = CU_PER_SOL_TRANSFER + CU_OVERHEAD;

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
      })
    );

    return this.sendAndConfirm(
      transaction,
      [senderKeypair],
      undefined,
      options.priorityFee ? cuLimit : undefined,
      options.onRetry
    );
  }

  /**
   * Transfer SPL Token
   */
  private async transferSplToken(
    senderKeypair: Keypair,
    recipientPubkey: PublicKey,
    amountTokens: number,
    mintAddress: string,
    options: { priorityFee?: boolean; onRetry?: (attempt: number) => void } = { priorityFee: true }
  ): Promise<string> {
    const mintPubkey = new PublicKey(mintAddress);

    // Get ATAs (Associated Token Accounts)
    const senderAta = await getAssociatedTokenAddress(mintPubkey, senderKeypair.publicKey);
    const recipientAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

    const transaction = new Transaction();

    // Check if recipient has ATA, if not create it (funded by sender)
    let needsAtaCreation = false;
    try {
      await getAccount(this.connection, recipientAta);
    } catch {
      needsAtaCreation = true;
      transaction.add(
        createAssociatedTokenAccountInstruction(
          senderKeypair.publicKey, // Payer
          recipientAta,
          recipientPubkey,
          mintPubkey
        )
      );
    }

    // Add transfer instruction (USDC/USDT have 6 decimals)
    const amountRaw = Math.round(amountTokens * 1_000_000);

    transaction.add(
      createTransferInstruction(senderAta, recipientAta, senderKeypair.publicKey, amountRaw)
    );

    const cuLimit =
      (needsAtaCreation ? CU_PER_ATA_CREATION : 0) + CU_PER_SPL_TRANSFER + CU_OVERHEAD;

    return this.sendAndConfirm(
      transaction,
      [senderKeypair],
      undefined,
      options.priorityFee ? cuLimit : undefined,
      options.onRetry
    );
  }
}
