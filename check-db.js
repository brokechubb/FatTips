const path = require('path');
const { PrismaClient } = require(
  path.join(__dirname, './packages/database/node_modules/@prisma/client')
);

const prisma = new PrismaClient({
  datasources: {
    db: { url: 'postgresql://fattips_user:SecurePass_wUB1E51mxmG8@localhost:5432/fattips' },
  },
});

async function main() {
  try {
    const tables =
      await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    console.log('Tables in database:', tables.map((t) => t.table_name).join(', '));

    const airdropCount = await prisma.airdrop.count();
    console.log('Airdrop count:', airdropCount);

    const poolCount = await prisma.airdropPoolWallet.count();
    console.log('Pool wallet count:', poolCount);

    const userCount = await prisma.user.count();
    console.log('User count:', userCount);
  } catch (e) {
    console.error('Error:', e.message);
  }
  await prisma.$disconnect();
}

main();
