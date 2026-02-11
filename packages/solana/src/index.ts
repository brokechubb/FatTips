// Placeholder for Solana utilities
import { Connection, PublicKey } from '@solana/web3.js';

export class SolanaClient {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl);
  }

  async getBalance(pubkey: PublicKey): Promise<number> {
    return this.connection.getBalance(pubkey);
  }
}

export { Connection, PublicKey };
export * from './wallet';
export * from './balance';
export * from './price';
export * from './transaction';
export * from './swap';
export * from './swap';

// Re-export TOKEN_MINTS explicitly from price
export { TOKEN_MINTS } from './price';
