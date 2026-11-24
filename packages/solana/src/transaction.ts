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
  AccountInfo,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { TOKEN_MINTS } from './price';

// Priority fee constants — expressed as ABSOLUTE lamports per transaction.
// Helius' per-CU price estimates are calibrated for large transactions
// (100k+ CU); on our tiny tip transfers (~3.5k CU) even the 'high' level
// diluted to ~600 lamports ≈ $0.0001, which got transactions deprioritized
// and dropped. Enforcing an absolute floor keeps small transfers competitive.
const PRIORITY_FEE_MIN_LAMPORTS = 10_000; // floor per tx (~$0.002) — keeps tips competitive
const PRIORITY_FEE_MAX_LAMPORTS = 500_000; // ceiling per tx (~$0.10) — bounds worst-case cost
const PRIORITY_FEE_FALLBACK_LAMPORTS = 25_000; // used when the dynamic estimate fails
// Fee is escalated on each retry attempt to improve inclusion odds under congestion.
const PRIORITY_FEE_ESCALATION_MULTIPLIER = 3; // each retry multiplies fee by this factor

// Compute unit estimates with generous 3x safety margin.
// If the limit is too tight, validators silently drop the transaction.
const CU_PER_SOL_TRANSFER = 1_500; // actual ~450, padded for safety
const CU_PER_SPL_TRANSFER = 15_000; // actual ~4k, padded for safety
const CU_PER_ATA_CREATION = 50_000; // actual ~25-30k, padded for safety
const CU_OVERHEAD = 2_000; // ComputeBudget instructions + signature verification

// Cap each confirmation wait at this duration instead of the full blockhash expiry
// (~45s). When it elapses, check on-chain status, re-propagate if the blockhash is
// still valid, and only escalate to a fresh-blockhash retry once provably expired.
// Kept short (5s): a dropped first broadcast is the #1 source of perceived tip
// delay, so recovery must be near-immediate rather than waiting the old 15s.
const CONFIRM_SOFT_TIMEOUT_MS = 5_000;
// Total wall-clock budget for one attempt's confirmation (re-propagate + re-wait
// cycles included). Keeps worst-case per-attempt latency bounded at ~30s instead
// of the ~50s full blockhash-expiry wait users were seeing.
const CONFIRM_SOFT_TOTAL_MS = 30_000;

// Fallback rent-exempt minimum (lamports) for a zero-data account, used only if
// the RPC cannot answer getMinimumBalanceForRentExemption.
// (128 + 0) * 5_080, per SIMD-0437's lowered lamports-per-byte. Rent has only
// moved down, so a stale value here over-funds a new wallet rather than failing.
const DEFAULT_RENT_EXEMPT_LAMPORTS = 650_240;

// Pause before retrying when the RPC rejects our blockhash during simulation.
// Gives a load-balanced RPC pool a moment to converge before we ask for a new
// blockhash and re-simulate.
const BLOCKHASH_RETRY_DELAY_MS = 750;

// User-facing message for attempts exhausted without the transaction landing.
const CONGESTION_ERROR_MESSAGE =
  'The Solana network is currently congested and could not process this transaction in time. Please try again in a moment.';

/**
 * True when a preflight/simulation failure only means the RPC did not recognize
 * the transaction's blockhash ("Blockhash not found" / `BlockhashNotFound`).
 *
 * A transaction rejected at simulation is never broadcast, so retrying with a
 * fresh blockhash cannot double-send. This usually happens on load-balanced RPC
 * pools when `getLatestBlockhash` and the preflight land on different backends,
 * or when the blockhash came from a fork that was abandoned.
 */
function isBlockhashRejected(combinedError: string): boolean {
  const normalized = combinedError.toLowerCase();
  return normalized.includes('blockhash not found') || normalized.includes('blockhashnotfound');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  private rentExemptMinLamports: number | null = null;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.sendOptions = {
      skipPreflight: true,
      preflightCommitment: 'confirmed',
      // Let the RPC rebroadcast (~every 2s until confirmed). A single forwarded
      // send gets dropped often enough to stall tips for the full soft-timeout
      // otherwise. Idempotent — same signed tx — so our own re-propagation in
      // confirmWithSoftTimeout stays safe alongside it.
      maxRetries: 5,
    };
  }

  /**
   * Rent-exempt minimum for an account with no data, in lamports.
   *
   * Solana rejects any transaction that leaves a *newly created* account below
   * this balance ("insufficient funds for rent"), so every SOL transfer aimed at
   * a brand-new wallet has to be at least this large. Cached per instance — the
   * value is a cluster constant (~0.00065024 SOL since SIMD-0437).
   */
  private async getRentExemptMinLamports(): Promise<number> {
    if (this.rentExemptMinLamports === null) {
      try {
        this.rentExemptMinLamports = await this.connection.getMinimumBalanceForRentExemption(0);
      } catch (error) {
        // Don't cache the fallback — the next transfer will try the RPC again
        console.warn(
          '[TransactionService] Could not fetch rent-exempt minimum, using fallback:',
          error instanceof Error ? error.message : error
        );
        return DEFAULT_RENT_EXEMPT_LAMPORTS;
      }
    }
    return this.rentExemptMinLamports;
  }

  /**
   * Count how many of the given wallets have never been funded (no on-chain account).
   *
   * Commands use this to reserve one rent exemption per brand-new recipient in
   * their balance checks, because dust tips/rains to a fresh wallet are topped up
   * to the rent-exempt minimum (see applyRentExemptionToNewAccounts).
   */
  async countUnfundedAccounts(pubkeys: string[]): Promise<number> {
    if (pubkeys.length === 0) return 0;

    const keys = pubkeys.map((pubkey) => new PublicKey(pubkey));
    let unfunded = 0;

    // getMultipleAccountsInfo caps out around 100 keys per call
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(chunk, 'confirmed');
      for (const info of infos) {
        if (!info || info.lamports === 0) unfunded++;
      }
    }

    return unfunded;
  }

  /**
   * Raise any SOL transfer that targets a never-funded wallet to the rent-exempt minimum.
   *
   * Tips and rains split a pot across many users, so a per-recipient share can land
   * below the rent-exempt minimum. Sending it would fail simulation with
   * "Transaction results in an account (1) with insufficient funds for rent".
   * Recipients that already have an account accept any amount, so only
   * non-existent accounts are adjusted. Airdrop settlement already does the same
   * for its payouts.
   */
  private async applyRentExemptionToNewAccounts<T extends { pubkey: PublicKey; lamports: number }>(
    transfers: T[]
  ): Promise<T[]> {
    const rentMin = await this.getRentExemptMinLamports();
    const candidates = transfers.filter((t) => t.lamports > 0 && t.lamports < rentMin);
    if (candidates.length === 0) return transfers;

    const needsTopUp = new Set<string>();

    for (let i = 0; i < candidates.length; i += 100) {
      const chunk = candidates.slice(i, i + 100);
      let infos: (AccountInfo<Buffer> | null)[];
      try {
        infos = await this.connection.getMultipleAccountsInfo(
          chunk.map((t) => t.pubkey),
          'confirmed'
        );
      } catch (error) {
        // Can't verify: leave the transfers untouched and let simulation report it
        console.warn(
          '[TransactionService] Could not check recipient rent exemption:',
          error instanceof Error ? error.message : error
        );
        return transfers;
      }

      chunk.forEach((transfer, index) => {
        const info = infos[index];
        if (!info || info.lamports === 0) needsTopUp.add(transfer.pubkey.toBase58());
      });
    }

    if (needsTopUp.size === 0) return transfers;

    return transfers.map((transfer) => {
      if (!needsTopUp.has(transfer.pubkey.toBase58())) return transfer;
      console.warn(
        `[TransactionService] New wallet ${transfer.pubkey.toBase58()} topped up from ` +
          `${transfer.lamports} to ${rentMin} lamports (rent exemption)`
      );
      return { ...transfer, lamports: rentMin };
    });
  }

  /**
   * Compute the priority fee for a transaction as an ABSOLUTE lamports amount,
   * converted to microLamports/CU for setComputeUnitPrice.
   *
   * Helius' getPriorityFeeEstimate returns microLamports/CU prices calibrated
   * for large transactions. Our tip transfers use only ~3.5k CU, so even the
   * 'high' level diluted to ~600 lamports ≈ $0.0001 — not enough to be
   * prioritized, and transactions got dropped. Converting via this tx's CU
   * limit and clamping to [PRIORITY_FEE_MIN_LAMPORTS, PRIORITY_FEE_MAX_LAMPORTS]
   * guarantees a meaningful fee regardless of transaction size, at a bounded
   * cost (worst case ~$0.10).
   *
   * Falls back to PRIORITY_FEE_FALLBACK_LAMPORTS if the RPC doesn't support the
   * estimate. On retry attempts the fee is escalated by
   * PRIORITY_FEE_ESCALATION_MULTIPLIER to improve inclusion odds under congestion.
   *
   * @returns microLamports per CU to pass to ComputeBudgetProgram.setComputeUnitPrice
   */
  private async getDynamicPriorityFee(attempt: number = 0, cuLimit?: number): Promise<number> {
    // Absolute lamports for this attempt, escalated from the base estimate
    let baseLamports: number;

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
      // Prefer 'high', falling down the ladder if a level is missing.
      // Levels are microLamports/CU prices — convert to absolute lamports
      // using THIS transaction's CU limit so tiny txs don't dilute to ~0.
      const basePrice =
        levels?.high ?? levels?.medium ?? levels?.low ?? data?.result?.priorityFeeEstimate;
      if (basePrice != null && cuLimit != null) {
        baseLamports = Math.ceil((basePrice * cuLimit) / 1_000_000);
      } else {
        baseLamports = PRIORITY_FEE_FALLBACK_LAMPORTS;
      }
    } catch (err) {
      console.warn(
        '[TransactionService] Failed to fetch dynamic priority fee, using fallback:',
        err
      );
      baseLamports = PRIORITY_FEE_FALLBACK_LAMPORTS;
    }

    // Escalate on retries: attempt 0 = base fee, attempt 1 = base*3, attempt 2 = base*9, etc.
    const escalated = Math.round(
      baseLamports * Math.pow(PRIORITY_FEE_ESCALATION_MULTIPLIER, attempt)
    );
    // Clamp to absolute bounds — the floor keeps small-CU transfers competitive,
    // the ceiling bounds worst-case cost under heavy congestion.
    const clamped = Math.min(
      Math.max(escalated, PRIORITY_FEE_MIN_LAMPORTS),
      PRIORITY_FEE_MAX_LAMPORTS
    );
    if (attempt > 0) {
      console.log(
        `[TransactionService] Priority fee: ${baseLamports} → ${clamped} lamports (attempt ${attempt + 1}, escalation ${PRIORITY_FEE_ESCALATION_MULTIPLIER}x)`
      );
    }
    // Convert back to microLamports/CU for setComputeUnitPrice
    if (cuLimit == null || cuLimit <= 0) {
      return clamped; // Defensive: callers always pass a CU limit
    }
    return Math.ceil((clamped * 1_000_000) / cuLimit);
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
      const solTransfers = await this.applyRentExemptionToNewAccounts(
        transfers.map((t) => ({
          pubkey: new PublicKey(t.recipient),
          lamports: Math.round(t.amount * LAMPORTS_PER_SOL),
        }))
      );
      for (const t of solTransfers) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: t.pubkey,
            lamports: t.lamports,
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
    maxRetries = 3,
    cuLimit?: number,
    onRetry?: (attempt: number) => void
  ): Promise<string> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Fetch dynamic priority fee for this attempt (escalates on retries)
      if (cuLimit !== undefined) {
        const priorityFee = await this.getDynamicPriorityFee(attempt, cuLimit);
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

      // Use the *finalized* blockhash. A finalized (rooted) blockhash is known to
      // every synced node, so a load-balanced RPC pool can't reject it with
      // "Blockhash not found" during preflight. It is ~13s older than the
      // confirmed head, but still leaves ~47s of validity — comfortably above
      // the soft confirmation budget — and we refresh it on every retry.
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('finalized');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = signers[0].publicKey;

      // First attempt: use preflight to catch simulation errors (insufficient balance, etc.)
      // Retries: skip preflight since we already know the tx structure is valid
      const opts = attempt === 0 ? { ...this.sendOptions, skipPreflight: false } : this.sendOptions;

      // Sign explicitly so we can serialize the signed tx for idempotent
      // re-propagation inside confirmWithSoftTimeout
      transaction.sign(...signers);
      const rawTransaction = transaction.serialize();
      // Kept inside the try so preflight/simulation failures go through the same
      // error mapping as confirmation failures (and never escape as raw
      // SendTransactionError dumps).
      let signature = '';
      try {
        signature = await this.connection.sendRawTransaction(rawTransaction, opts);
        // Soft-timeout confirmation: re-propagates while the blockhash is valid,
        // escalates to a fresh-blockhash retry as soon as it provably expires.
        await this.confirmWithSoftTimeout(
          signature,
          rawTransaction,
          blockhash,
          lastValidBlockHeight
        );
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
          throw new Error(CONGESTION_ERROR_MESSAGE);
        }

        // SendTransactionError — extract logs. Most simulation failures are
        // terminal, but a rejected blockhash is not: the transaction never
        // reached the network, so retry it with a fresh blockhash.
        if (error instanceof SendTransactionError) {
          const logs = await error.getLogs(this.connection).catch(() => undefined);
          console.error('[TransactionService] Transaction failed. Logs:', logs);

          const combined = `${error.message} ${logs?.join(' ') ?? ''}`;

          if (isBlockhashRejected(combined)) {
            if (attempt < maxRetries - 1) {
              console.warn(
                `[TransactionService] RPC rejected the blockhash on attempt ${attempt + 1}/${maxRetries}, retrying with a fresh one...`
              );
              await sleep(BLOCKHASH_RETRY_DELAY_MS);
              onRetry?.(attempt + 1);
              continue;
            }
            console.warn(
              `[TransactionService] RPC kept rejecting the blockhash after ${maxRetries} attempts`
            );
            throw new Error(CONGESTION_ERROR_MESSAGE);
          }

          // Brand-new wallet paid less than the rent-exempt minimum. The transfer
          // paths top these up automatically, so reaching this means the sender
          // could not cover the top-up.
          if (combined.includes('insufficient funds for rent')) {
            const rentSol = (await this.getRentExemptMinLamports()) / LAMPORTS_PER_SOL;
            throw new Error(
              `a recipient's wallet is brand new and the amount is below ` +
                `the rent-exempt minimum. A new wallet must receive at least ` +
                `${rentSol.toFixed(8)} SOL. Try a larger amount, or make sure your wallet can ` +
                `cover that top-up for each new recipient.`
            );
          }

          throw new Error(logs?.join(' | ') || error.message);
        }

        // A bare JSON-RPC error can also report a rejected blockhash (some
        // providers omit `data.logs`, so web3.js doesn't wrap it in a
        // SendTransactionError). Same rule: never broadcast, so retry safely.
        if (
          !(error instanceof SendTransactionError) &&
          error instanceof Error &&
          isBlockhashRejected(error.message)
        ) {
          if (attempt < maxRetries - 1) {
            console.warn(
              `[TransactionService] RPC rejected the blockhash on attempt ${attempt + 1}/${maxRetries}, retrying with a fresh one...`
            );
            await sleep(BLOCKHASH_RETRY_DELAY_MS);
            onRetry?.(attempt + 1);
            continue;
          }
          console.warn(
            `[TransactionService] RPC kept rejecting the blockhash after ${maxRetries} attempts`
          );
          throw new Error(CONGESTION_ERROR_MESSAGE);
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

    // Top up dust transfers to never-funded wallets so they clear rent exemption
    const [transfer] = await this.applyRentExemptionToNewAccounts([
      { pubkey: recipientPubkey, lamports: Math.round(amountSol * LAMPORTS_PER_SOL) },
    ]);

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: transfer.pubkey,
        lamports: transfer.lamports,
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
