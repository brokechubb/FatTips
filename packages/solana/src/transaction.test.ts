import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SendTransactionError, Transaction } from '@solana/web3.js';
import { TransactionService } from './transaction';

const RENT_EXEMPT_MIN = 650_240; // lamports for a zero-data account (SIMD-0437, 5,080/byte)

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

type SendInternals = {
  sendAndConfirm: (
    transaction: Transaction,
    signers: Keypair[],
    maxRetries?: number,
    cuLimit?: number,
    onRetry?: (attempt: number) => void
  ) => Promise<string>;
};

type SendServiceStubs = {
  getLatestBlockhash?: (
    commitment?: string
  ) => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction?: (rawTransaction: Uint8Array, options?: unknown) => Promise<string>;
};

/** Builds a TransactionService with just enough of the RPC connection stubbed to send. */
function makeSendService(stubs: SendServiceStubs): TransactionService {
  const service = new TransactionService('http://localhost:8899');

  (service as unknown as { connection: unknown }).connection = {
    getLatestBlockhash:
      stubs.getLatestBlockhash ??
      (async () => ({
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 1_000,
      })),
    sendRawTransaction: stubs.sendRawTransaction,
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatus: async () => ({ value: null }),
    getBlockHeight: async () => 1,
    getTransaction: async () => null,
  };

  return service;
}

function blockhashNotFoundError(): SendTransactionError {
  return new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Transaction simulation failed: Blockhash not found',
    logs: [],
  });
}

function sendTransaction(service: TransactionService, signer: Keypair, maxRetries: number) {
  return (service as unknown as SendInternals).sendAndConfirm(
    new Transaction(),
    [signer],
    maxRetries
  );
}

describe('TransactionService blockhash rejection handling', () => {
  const signer = Keypair.generate();

  it('retries with a fresh blockhash when preflight rejects it', async () => {
    let blockhashCalls = 0;
    let sendCalls = 0;
    const commitments: (string | undefined)[] = [];

    const service = makeSendService({
      getLatestBlockhash: async (commitment) => {
        commitments.push(commitment);
        blockhashCalls++;
        return {
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1_000 + blockhashCalls,
        };
      },
      sendRawTransaction: async () => {
        sendCalls++;
        if (sendCalls === 1) throw blockhashNotFoundError();
        return 'signature-after-retry';
      },
    });

    const signature = await sendTransaction(service, signer, 2);

    expect(signature).toBe('signature-after-retry');
    expect(sendCalls).toBe(2);
    expect(blockhashCalls).toBe(2);
    expect(commitments).toEqual(['finalized', 'finalized']);
  });

  it('reports congestion when every attempt rejects the blockhash', async () => {
    let sendCalls = 0;
    const service = makeSendService({
      sendRawTransaction: async () => {
        sendCalls++;
        throw blockhashNotFoundError();
      },
    });

    await expect(sendTransaction(service, signer, 2)).rejects.toThrow(
      /network is currently congested/
    );
    expect(sendCalls).toBe(2);
  });

  it('does not retry simulation failures unrelated to the blockhash', async () => {
    let sendCalls = 0;
    const service = makeSendService({
      sendRawTransaction: async () => {
        sendCalls++;
        throw new SendTransactionError({
          action: 'simulate',
          signature: '',
          transactionMessage:
            'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.',
          logs: [],
        });
      },
    });

    await expect(sendTransaction(service, signer, 3)).rejects.toThrow(/Attempt to debit/);
    expect(sendCalls).toBe(1);
  });

  it('retries when a bare RPC error reports the rejected blockhash', async () => {
    let sendCalls = 0;
    const service = makeSendService({
      sendRawTransaction: async () => {
        sendCalls++;
        if (sendCalls === 1) {
          throw new Error('Transaction simulation failed: Blockhash not found');
        }
        return 'signature-from-bare-error-retry';
      },
    });

    const signature = await sendTransaction(service, signer, 2);

    expect(signature).toBe('signature-from-bare-error-retry');
    expect(sendCalls).toBe(2);
  });
});
