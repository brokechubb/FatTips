-- DropForeignKey
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_fromId_fkey";

-- DropForeignKey
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_toId_fkey";

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "fromAddress" TEXT,
ADD COLUMN     "toAddress" TEXT,
ALTER COLUMN "fromId" DROP NOT NULL,
ALTER COLUMN "toId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "User"("discordId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_toId_fkey" FOREIGN KEY ("toId") REFERENCES "User"("discordId") ON DELETE SET NULL ON UPDATE CASCADE;
