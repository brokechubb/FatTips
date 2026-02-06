-- AlterTable
ALTER TABLE "User" ADD COLUMN     "encryptedMnemonic" TEXT,
ADD COLUMN     "mnemonicSalt" TEXT;
