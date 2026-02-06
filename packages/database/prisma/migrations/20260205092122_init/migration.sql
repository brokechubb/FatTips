-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('TIP', 'DEPOSIT', 'WITHDRAWAL', 'AIRDROP_CLAIM', 'FORFEIT');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "AirdropStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SETTLED', 'RECLAIMED');

-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('PENDING', 'TRANSFERRED', 'FORFEITED');

-- CreateTable
CREATE TABLE "User" (
    "discordId" TEXT NOT NULL,
    "walletPubkey" TEXT NOT NULL,
    "encryptedPrivkey" TEXT NOT NULL,
    "keySalt" TEXT NOT NULL,
    "seedDelivered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActive" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("discordId")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "amountUsd" DECIMAL(10,2) NOT NULL,
    "amountToken" DECIMAL(20,9) NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "usdRate" DECIMAL(20,9) NOT NULL,
    "txType" "TxType" NOT NULL,
    "status" "TxStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Airdrop" (
    "id" TEXT NOT NULL,
    "onChainPda" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amountTotal" DECIMAL(20,9) NOT NULL,
    "amountClaimed" DECIMAL(20,9) NOT NULL DEFAULT 0,
    "tokenMint" TEXT NOT NULL,
    "maxParticipants" INTEGER NOT NULL,
    "participantCount" INTEGER NOT NULL DEFAULT 0,
    "status" "AirdropStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Airdrop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirdropParticipant" (
    "id" TEXT NOT NULL,
    "airdropId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shareAmount" DECIMAL(20,9) NOT NULL,
    "hasWalletAtClaim" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "walletCreatedBy" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "notificationsSent" JSONB NOT NULL DEFAULT '{}',
    "status" "ParticipantStatus" NOT NULL DEFAULT 'PENDING',
    "txSignature" TEXT,

    CONSTRAINT "AirdropParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotTreasury" (
    "id" TEXT NOT NULL,
    "sourceAirdropId" TEXT NOT NULL,
    "originalUserId" TEXT NOT NULL,
    "amount" DECIMAL(20,9) NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "forfeitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "BotTreasury_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_walletPubkey_key" ON "User"("walletPubkey");

-- CreateIndex
CREATE INDEX "User_walletPubkey_idx" ON "User"("walletPubkey");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_signature_key" ON "Transaction"("signature");

-- CreateIndex
CREATE INDEX "Transaction_fromId_createdAt_idx" ON "Transaction"("fromId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_toId_createdAt_idx" ON "Transaction"("toId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Airdrop_onChainPda_key" ON "Airdrop"("onChainPda");

-- CreateIndex
CREATE INDEX "Airdrop_status_expiresAt_idx" ON "Airdrop"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Airdrop_creatorId_idx" ON "Airdrop"("creatorId");

-- CreateIndex
CREATE INDEX "AirdropParticipant_status_deadline_idx" ON "AirdropParticipant"("status", "deadline");

-- CreateIndex
CREATE INDEX "AirdropParticipant_userId_idx" ON "AirdropParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AirdropParticipant_airdropId_userId_key" ON "AirdropParticipant"("airdropId", "userId");

-- CreateIndex
CREATE INDEX "BotTreasury_originalUserId_idx" ON "BotTreasury"("originalUserId");

-- CreateIndex
CREATE INDEX "BotTreasury_forfeitedAt_idx" ON "BotTreasury"("forfeitedAt");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_toId_fkey" FOREIGN KEY ("toId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Airdrop" ADD CONSTRAINT "Airdrop_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirdropParticipant" ADD CONSTRAINT "AirdropParticipant_airdropId_fkey" FOREIGN KEY ("airdropId") REFERENCES "Airdrop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirdropParticipant" ADD CONSTRAINT "AirdropParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;
