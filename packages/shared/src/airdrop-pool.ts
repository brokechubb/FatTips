import { prisma } from 'fattips-database';
import { WalletService, BalanceService, TransactionService, TOKEN_MINTS } from 'fattips-solana';

export class AirdropPoolService {
  private walletService: WalletService;
  private balanceService: BalanceService;
  private transactionService: TransactionService;

  constructor() {
    const masterKey = process.env.MASTER_ENCRYPTION_KEY;
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!masterKey) {
      throw new Error('MASTER_ENCRYPTION_KEY environment variable is not set');
    }
    if (!rpcUrl) {
      throw new Error('SOLANA_RPC_URL environment variable is not set');
    }
    this.walletService = new WalletService(masterKey);
    this.balanceService = new BalanceService(rpcUrl);
    this.transactionService = new TransactionService(rpcUrl);
  }

  /**
   * Get an available wallet from the pool or create a new one.
   * Uses ATOMIC Postgres locking to prevent race conditions.
   */
  async getOrCreateWallet(): Promise<{
    address: string;
    encryptedPrivkey: string;
    keySalt: string;
  }> {
    try {
      // Use raw SQL for atomic "grab" - SELECT FOR UPDATE SKIP LOCKED
      // This is the industry standard for picking a unique item from a pool/queue
      const result = await prisma.$queryRaw<any[]>`
        UPDATE "AirdropPoolWallet"
        SET "isBusy" = true, "lastUsedAt" = NOW()
        WHERE address = (
          SELECT address
          FROM "AirdropPoolWallet"
          WHERE "isBusy" = false
          ORDER BY "lastUsedAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING address, "encryptedPrivkey", "keySalt";
      `;

      if (result && result.length > 0) {
        const wallet = result[0];
        console.log(`[POOL] Reusing existing wallet: ${wallet.address}`);
        return {
          address: wallet.address,
          encryptedPrivkey: wallet.encryptedPrivkey,
          keySalt: wallet.keySalt,
        };
      }

      // No available wallet, create a new one
      const newWallet = await this.walletService.createEncryptedWallet();
      console.log(`[POOL] Pool empty, creating new wallet: ${newWallet.publicKey}`);

      const created = await prisma.airdropPoolWallet.create({
        data: {
          address: newWallet.publicKey,
          encryptedPrivkey: newWallet.encryptedPrivateKey,
          keySalt: newWallet.keySalt,
          isBusy: true,
          lastUsedAt: new Date(),
        },
      });

      return {
        address: created.address,
        encryptedPrivkey: created.encryptedPrivkey,
        keySalt: created.keySalt,
      };
    } catch (error) {
      console.error('[POOL] Error in getOrCreateWallet:', error);
      throw error;
    }
  }

  /**
   * Release a wallet back to the pool after sweeping dust.
   * Optionally pass the airdropId that was just finished to ensure correct creator refund.
   *
   * SAFETY: This function will REFUSE to release a wallet if the associated airdrop
   * is still in ACTIVE or PENDING status - this prevents premature release during
   * failed airdrop creations.
   */
  async releaseWallet(address: string, airdropId?: string) {
    try {
      console.log(
        `[POOL] Sweeping and releasing wallet: ${address}${airdropId ? ` (for airdrop ${airdropId})` : ''}`
      );

      // SAFETY CHECK: Verify airdrop status before releasing
      // We NEVER release a wallet while an airdrop is still pending/active
      if (airdropId) {
        const airdrop = await prisma.airdrop.findUnique({ where: { id: airdropId } });

        console.log(
          `[POOL] Checking airdrop ${airdropId} status before release: ${airdrop?.status || 'NOT FOUND'}`
        );

        // Only release if the airdrop is in a terminal state
        if (airdrop && !['SETTLED', 'EXPIRED', 'FAILED', 'RECLAIMED'].includes(airdrop.status)) {
          console.error(
            `[POOL] 🚨 BLOCKED: Refusing to release wallet ${address} for airdrop ${airdropId} - status is ${airdrop.status} (not a terminal state)`
          );
          // DO NOT release - this would indicate a bug in the airdrop creation flow
          return;
        }

        console.log(
          `[POOL] Airdrop ${airdropId} is in terminal state (${airdrop?.status}), proceeding with release`
        );
      }

      // 1. Identify the correct creator to refund
      let targetCreatorWallet: string | null = null;

      if (airdropId) {
        const ad = await prisma.airdrop.findUnique({
          where: { id: airdropId },
          include: { creator: true },
        });
        targetCreatorWallet = ad?.creator.walletPubkey || null;
      }

      // Fallback: Use the last record associated with this wallet (only if airdropId not provided or not found)
      if (!targetCreatorWallet) {
        const lastAirdrop = await prisma.airdrop.findFirst({
          where: { walletPubkey: address },
          orderBy: { createdAt: 'desc' },
          include: { creator: true },
        });
        targetCreatorWallet = lastAirdrop?.creator.walletPubkey || null;
      }

      if (targetCreatorWallet) {
        try {
          // Get fresh balance with retry to handle RPC latency
          let balances;
          let previousBalance: number | null = null;
          const MAX_BALANCE_RETRIES = 5;
          for (let attempt = 1; attempt <= MAX_BALANCE_RETRIES; attempt++) {
            balances = await this.balanceService.getBalances(address);
            console.log(
              `[POOL] Balance check attempt ${attempt}: ${balances.sol} SOL, ${balances.usdc} USDC, ${balances.usdt} USDT`
            );

            // If this isn't the first attempt and balance hasn't changed, RPC may be stale
            // Continue retrying to wait for consistency
            if (attempt > 1 && previousBalance !== null && balances.sol === previousBalance) {
              console.log(`[POOL] Balance unchanged from previous attempt, RPC may be stale...`);
              // Don't break yet, continue retrying unless this is the last attempt
              if (attempt < MAX_BALANCE_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                previousBalance = balances.sol;
                continue;
              }
            }

            // Store balance for comparison in next iteration
            previousBalance = balances.sol;

            // Only proceed if we have a reasonable balance or we've exhausted retries
            // Note: We proceed even with 0 balance after MAX attempts because the airdrop
            // may have successfully distributed all funds to winners
            if (balances.sol > 0.001 || attempt === MAX_BALANCE_RETRIES) {
              console.log(
                `[POOL] Proceeding with sweep. Balance: ${balances.sol} SOL, USDC: ${balances.usdc}, USDT: ${balances.usdt}`
              );
              // Add extra delay after distributions to allow RPC propagation
              if (attempt < MAX_BALANCE_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          const walletData = await prisma.airdropPoolWallet.findUnique({ where: { address } });

          if (walletData) {
            const keypair = await this.walletService.getKeypair(
              walletData.encryptedPrivkey,
              walletData.keySalt
            );

            // Sweep SPL Tokens (USDC/USDT)
            if (balances!.usdc > 0) {
              await this.transactionService.transfer(
                keypair,
                targetCreatorWallet,
                balances!.usdc,
                TOKEN_MINTS.USDC
              );
              console.log(`[POOL] Swept ${balances!.usdc} USDC to ${targetCreatorWallet}`);
            }
            if (balances!.usdt > 0) {
              await this.transactionService.transfer(
                keypair,
                targetCreatorWallet,
                balances!.usdt,
                TOKEN_MINTS.USDT
              );
              console.log(`[POOL] Swept ${balances!.usdt} USDT to ${targetCreatorWallet}`);
            }

            // Sweep SOL (leave buffer for rent + tx fee)
            // Use more conservative buffer to avoid "insufficient lamports" errors
            const TX_FEE_BUFFER = 0.00001; // Extra buffer for transaction fee
            const RENT_BUFFER = 0.001;
            const solDust = balances!.sol - RENT_BUFFER - TX_FEE_BUFFER;
            if (solDust > 0.00001) {
              try {
                await this.transactionService.transfer(
                  keypair,
                  targetCreatorWallet,
                  solDust,
                  TOKEN_MINTS.SOL
                );
                console.log(`[POOL] Swept ${solDust} SOL to ${targetCreatorWallet}`);
              } catch (sweepTxError: any) {
                // If sweep fails due to insufficient balance, try with smaller amount
                // Check both message and logs since Solana errors have logs in a separate property
                const errorText = `${sweepTxError.message || ''} ${JSON.stringify(sweepTxError.logs || [])}`;
                if (errorText.includes('insufficient lamports')) {
                  console.log(
                    `[POOL] Initial sweep failed due to insufficient balance, fetching actual balance...`
                  );
                  // Get fresh balance and try to sweep almost everything
                  // Add delay to allow RPC to sync
                  await new Promise((resolve) => setTimeout(resolve, 2000));
                  const freshBalances = await this.balanceService.getBalances(address);
                  console.log(`[POOL] Fresh balance: ${freshBalances.sol} SOL`);
                  const smallerSweep = freshBalances.sol - RENT_BUFFER - TX_FEE_BUFFER;
                  if (smallerSweep > 0.00001) {
                    await this.transactionService.transfer(
                      keypair,
                      targetCreatorWallet,
                      smallerSweep,
                      TOKEN_MINTS.SOL
                    );
                    console.log(
                      `[POOL] Swept ${smallerSweep} SOL (adjusted) to ${targetCreatorWallet}`
                    );
                  } else {
                    console.log(
                      `[POOL] Balance too low to sweep (${freshBalances.sol} SOL), skipping sweep`
                    );
                  }
                } else {
                  throw sweepTxError;
                }
              }
            }
          }
        } catch (sweepError) {
          console.error(`[POOL] Failed to sweep wallet ${address}:`, sweepError);
          // Continue to release even if sweep fails - don't want to lock the wallet forever
        }
      }

      await prisma.airdropPoolWallet.update({
        where: { address },
        data: { isBusy: false },
      });
      console.log(`[POOL] Released wallet: ${address}`);
    } catch (err) {
      console.warn(`[POOL] Failed to release wallet ${address}:`, err);
    }
  }
}
