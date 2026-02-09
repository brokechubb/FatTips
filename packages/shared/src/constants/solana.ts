/**
 * Solana constants for FatTips bot
 */

// Minimum rent exemption for a Solana account
export const MIN_RENT_EXEMPTION = 0.00089088; // SOL

// Fee buffers for different operations
export const FEE_BUFFERS = {
  // Small buffer for single transactions
  TINY: 0.00001, // SOL

  // Standard buffer for most operations
  STANDARD: 0.00002, // SOL

  // Larger buffer for batch operations
  BATCH: 0.000005, // SOL per transaction

  // Gas buffer for airdrop ephemeral wallets
  AIRDROP_GAS: 0.003, // SOL

  // Standard buffer for prefix commands
  PREFIX_STANDARD: 0.002, // SOL
} as const;

// Rent reserves for different contexts
export const RENT_RESERVES = {
  // Standard reserve to keep account active
  STANDARD: MIN_RENT_EXEMPTION,

  // Slightly higher buffer for safety
  SAFETY: 0.001, // SOL (old value, kept for compatibility)
} as const;

// Minimum amounts for different tokens
export const MINIMUM_AMOUNTS = {
  SOL: 0.001, // SOL
  USDC: 0.01, // USDC
  USDT: 0.01, // USDT
} as const;
