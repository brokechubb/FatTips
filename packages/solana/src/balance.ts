import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { TOKEN_MINTS } from './price';

export interface BalanceData {
  sol: number;
  usdc: number;
  usdt: number;
}

export class BalanceService {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl);
  }

  /**
   * Fetch SOL and token balances for a wallet
   */
  async getBalances(walletPubkey: string): Promise<BalanceData> {
    const pubkey = new PublicKey(walletPubkey);

    // Get SOL balance (in lamports, convert to SOL)
    const solBalance = await this.connection.getBalance(pubkey);

    // Get USDC balance
    const usdcBalance = await this.getTokenBalance(pubkey, TOKEN_MINTS.USDC);

    // Get USDT balance
    const usdtBalance = await this.getTokenBalance(pubkey, TOKEN_MINTS.USDT);

    return {
      sol: solBalance / 1e9, // Convert lamports to SOL
      usdc: usdcBalance,
      usdt: usdtBalance,
    };
  }

  /**
   * Get token balance for a specific mint
   */
  private async getTokenBalance(walletPubkey: PublicKey, mintAddress: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const associatedTokenAddress = await getAssociatedTokenAddress(mintPubkey, walletPubkey);

      const tokenAccount = await getAccount(this.connection, associatedTokenAddress);

      return Number(tokenAccount.amount) / 1e6; // USDC/USDT have 6 decimals
    } catch {
      // Account doesn't exist means 0 balance
      return 0;
    }
  }

  /**
   * Format balance for display
   */
  static formatBalance(amount: number, decimals: number = 4): string {
    if (amount === 0) return '0';
    if (amount < 0.0001) return amount.toExponential(2);
    return amount.toFixed(decimals);
  }
}
