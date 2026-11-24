/**
 * Solana constants for FatTips bot
 */

// -----------------------------------------------------------------------------
// Rent exemption (SIMD-0437)
//
// Every account must hold `(128 + dataSize) * lamportsPerByte` lamports. SIMD-0437
// lowered `lamportsPerByte` from 6,960 to 5,080 on mainnet (epoch 1033, Sept 2026)
// and is feature-gated down to 696 in later steps. That took a wallet's deposit
// from 0.00089088 SOL to 0.00065024 SOL and a token account's from 0.00203928 SOL
// to 0.00148844 SOL.
//
// These are planning/fallback values. Whenever the cluster can be asked directly,
// prefer `Connection.getMinimumBalanceForRentExemption(dataSize)` — TransactionService
// and airdrop settlement already do. A *higher* reserve than the live minimum is
// always safe (rent has only moved down), so stale constants never break a transfer.
// -----------------------------------------------------------------------------

/** Lamports charged per byte of account storage (SIMD-0437, step 2). */
export const LAMPORTS_PER_BYTE = 5_080;

/** Fixed per-account storage overhead charged on top of the data size. */
export const ACCOUNT_OVERHEAD_BYTES = 128;

/** Size of a classic SPL token account (also the size of an associated token account). */
export const TOKEN_ACCOUNT_SIZE_BYTES = 165;

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Rent-exempt minimum in lamports for an account holding `dataSize` bytes. */
export function rentExemptLamports(dataSize: number = 0): number {
  return (ACCOUNT_OVERHEAD_BYTES + dataSize) * LAMPORTS_PER_BYTE;
}

/**
 * Rent-exempt minimum for a wallet (zero-data System Program account), in SOL.
 * Also serves as the floor a funded wallet must leave behind after a transfer.
 */
export const MIN_RENT_EXEMPTION = rentExemptLamports(0) / LAMPORTS_PER_SOL; // 0.00065024 SOL

/** Same as MIN_RENT_EXEMPTION, in lamports (650_240). */
export const MIN_RENT_EXEMPTION_LAMPORTS = rentExemptLamports(0);

/** Rent-exempt minimum for opening a new SPL token account / ATA, in SOL. */
export const TOKEN_ACCOUNT_RENT_EXEMPTION =
  rentExemptLamports(TOKEN_ACCOUNT_SIZE_BYTES) / LAMPORTS_PER_SOL; // 0.00148844 SOL

/** Same as TOKEN_ACCOUNT_RENT_EXEMPTION, in lamports (1_488_440). */
export const TOKEN_ACCOUNT_RENT_EXEMPTION_LAMPORTS = rentExemptLamports(TOKEN_ACCOUNT_SIZE_BYTES);

// Fee buffers for different operations
export const FEE_BUFFERS = {
  // Small buffer for single transactions
  TINY: 0.00001, // SOL

  // Standard buffer for most operations (covers priority fees)
  STANDARD: 0.001, // SOL

  // Larger buffer for batch operations
  BATCH: 0.000005, // SOL per transaction

  // Gas buffer for airdrop ephemeral wallets
  AIRDROP_GAS: 0.003, // SOL

  // Standard buffer for prefix commands
  PREFIX_STANDARD: 0.002, // SOL
} as const;

// Rent reserves for different contexts
export const RENT_RESERVES = {
  // Reserve to keep an existing wallet account alive
  STANDARD: MIN_RENT_EXEMPTION,

  // Reserve for contexts that may also create a token account
  SAFETY: TOKEN_ACCOUNT_RENT_EXEMPTION,
} as const;

// Minimum amounts for different tokens
export const MINIMUM_AMOUNTS = {
  SOL: 0.001, // SOL
  USDC: 0.01, // USDC
  USDT: 0.01, // USDT
} as const;
