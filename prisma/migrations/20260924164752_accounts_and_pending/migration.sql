-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('BANK', 'CREDIT_CARD', 'MEAL_VOUCHER', 'FOOD_VOUCHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Category" ADD VALUE 'VALE_REFEICAO';
ALTER TYPE "Category" ADD VALUE 'VALE_ALIMENTACAO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'VR';
ALTER TYPE "PaymentMethod" ADD VALUE 'VA';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "accountId" INTEGER,
ADD COLUMN     "installments" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "accounts" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "initialBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "creditLimitCents" INTEGER,
    "closingDay" INTEGER,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_entries" (
    "id" SERIAL NOT NULL,
    "drafts" JSONB NOT NULL,
    "rawInput" TEXT NOT NULL,
    "source" "InputSource" NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transactions_accountId_idx" ON "transactions"("accountId");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Adicionado manualmente: o Prisma não expressa CHECK constraints no schema.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_installments_range" CHECK ("installments" BETWEEN 1 AND 48);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_closingDay_range" CHECK ("closingDay" BETWEEN 1 AND 31);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_creditLimitCents_positive" CHECK ("creditLimitCents" > 0);
-- Uma linha só (o bot tem um único usuário).
ALTER TABLE "chat_state" ADD CONSTRAINT "chat_state_single_row" CHECK ("id" = 1);
