import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Populating Airdrop Wallet Pool from existing airdrops...');

  // 1. Get all airdrops with keys
  const airdrops = await prisma.airdrop.findMany({
    select: {
      walletPubkey: true,
      encryptedPrivkey: true,
      keySalt: true,
      status: true,
    },
  });

  console.log(`Found ${airdrops.length} existing airdrop records.`);

  // 2. Extract unique wallets
  const uniqueWallets = new Map<string, { encryptedPrivkey: string; keySalt: string; isBusy: boolean }>();

  for (const ad of airdrops) {
    const isBusy = ad.status === 'ACTIVE' || ad.status === 'PENDING';
    
    // If we already saw this wallet, update busy status if current record is active
    if (uniqueWallets.has(ad.walletPubkey)) {
      if (isBusy) {
        uniqueWallets.get(ad.walletPubkey)!.isBusy = true;
      }
      continue;
    }

    uniqueWallets.set(ad.walletPubkey, {
      encryptedPrivkey: ad.encryptedPrivkey,
      keySalt: ad.keySalt,
      isBusy,
    });
  }

  console.log(`Found ${uniqueWallets.size} unique wallets.`);

  // 3. Upsert into AirdropPoolWallet
  let count = 0;
  for (const [address, data] of uniqueWallets.entries()) {
    await prisma.airdropPoolWallet.upsert({
      where: { address },
      update: {
        isBusy: data.isBusy,
      },
      create: {
        address,
        encryptedPrivkey: data.encryptedPrivkey,
        keySalt: data.keySalt,
        isBusy: data.isBusy,
      },
    });
    count++;
  }

  // 4. Update poolWalletAddress in Airdrop table for existing records
  console.log('Updating Airdrop records to link to pool wallets...');
  await prisma.$executeRaw`UPDATE "Airdrop" SET "poolWalletAddress" = "walletPubkey" WHERE "poolWalletAddress" IS NULL`;

  console.log(`✅ Successfully added ${count} wallets to the pool.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
