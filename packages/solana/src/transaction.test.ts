import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TransactionService } from './transaction';

const RENT_EXEMPT_MIN = 890_880; // lamports for a zero-data account

type SolTransfer = { pubkey: PublicKey; lamports: number };

type RentExemptionInternals = {
  applyRentExemptionToNewAccounts: (transfers: SolTransfer[]) => Promise<SolTransfer[]>;
};

/**
 * Builds a TransactionService whose RPC connection is stubbed out. `funded` maps
 * wallet addresses to their on-chain lamport balance; anything absent is treated
 * as a wallet that has never been funded (getAccountInfo → null).
 */
function makeService(funded: Record<string, number>): TransactionService {
  const service = new TransactionService('http://localhost:8899');

  (service as unknown as { connection: unknown }).connection = {
    getMinimumBalanceForRentExemption: async () => RENT_EXEMPT_MIN,
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((key) => {
        const lamports = funded[key.toBase58()];
        return lamports === undefined
          ? null
          : { lamports, data: Buffer.alloc(0), executable: false };
      }),
  };

  return service;
}

function applyRentExemption(service: TransactionService, transfers: SolTransfer[]) {
  return (service as unknown as RentExemptionInternals).applyRentExemptionToNewAccounts(transfers);
}

describe('TransactionService rent-exempt handling', () => {
  const existingWallet = Keypair.generate().publicKey;
  const freshWallet = Keypair.generate().publicKey;

  it('tops up a dust transfer aimed at a never-funded wallet', async () => {
    const service = makeService({});
    const result = await applyRentExemption(service, [{ pubkey: freshWallet, lamports: 109_000 }]);

    expect(result[0].lamports).toBe(RENT_EXEMPT_MIN);
  });

  it('leaves transfers to wallets that already exist untouched', async () => {
    const service = makeService({ [existingWallet.toBase58()]: 5_000_000 });
    const result = await applyRentExemption(service, [
      { pubkey: existingWallet, lamports: 109_000 },
    ]);

    expect(result[0].lamports).toBe(109_000);
  });

  it('never lowers a transfer that is already above the minimum', async () => {
    const service = makeService({});
    const result = await applyRentExemption(service, [
      { pubkey: freshWallet, lamports: 2_000_000 },
    ]);

    expect(result[0].lamports).toBe(2_000_000);
  });

  it('adjusts only the new wallets in a batch', async () => {
    const service = makeService({ [existingWallet.toBase58()]: 1_000_000 });
    const result = await applyRentExemption(service, [
      { pubkey: existingWallet, lamports: 109_000 },
      { pubkey: freshWallet, lamports: 109_000 },
    ]);

    expect(result[0].lamports).toBe(109_000);
    expect(result[1].lamports).toBe(RENT_EXEMPT_MIN);
  });

  it('counts wallets that have no on-chain account yet', async () => {
    const service = makeService({ [existingWallet.toBase58()]: 1_000_000 });
    const count = await service.countUnfundedAccounts([
      existingWallet.toBase58(),
      freshWallet.toBase58(),
    ]);

    expect(count).toBe(1);
  });
});
