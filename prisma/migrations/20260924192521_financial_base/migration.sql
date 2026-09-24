-- CreateEnum
CREATE TYPE "PendingPurpose" AS ENUM ('TRANSACTION', 'RECURRING');

-- AlterEnum
ALTER TYPE "Category" ADD VALUE 'INVESTIMENTO';

-- AlterEnum
ALTER TYPE "InputSource" ADD VALUE 'RECURRING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'INVESTMENT';
ALTER TYPE "TransactionType" ADD VALUE 'REDEMPTION';

-- AlterTable
ALTER TABLE "invoice_payments" ADD COLUMN     "amountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paidFromAccountId" INTEGER;

-- AlterTable
ALTER TABLE "pending_entries" ADD COLUMN     "purpose" "PendingPurpose" NOT NULL DEFAULT 'TRANSACTION',
ADD COLUMN     "recurringDay" INTEGER;

-- CreateTable
CREATE TABLE "budgets" (
    "id" SERIAL NOT NULL,
    "category" "Category" NOT NULL,
    "limitCents" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_entries" (
    "id" SERIAL NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "paymentMethod" "PaymentMethod",
    "accountId" INTEGER,
    "dayOfMonth" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunMonth" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_state" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_state_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "budgets_category_key" ON "budgets"("category");

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_paidFromAccountId_fkey" FOREIGN KEY ("paidFromAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_entries" ADD CONSTRAINT "recurring_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Adicionado manualmente: o Prisma não expressa CHECK constraints no schema.
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_limitCents_positive" CHECK ("limitCents" > 0);
ALTER TABLE "recurring_entries" ADD CONSTRAINT "recurring_entries_amountCents_positive" CHECK ("amountCents" > 0);
ALTER TABLE "recurring_entries" ADD CONSTRAINT "recurring_entries_dayOfMonth_range" CHECK ("dayOfMonth" BETWEEN 1 AND 31);
ALTER TABLE "pending_entries" ADD CONSTRAINT "pending_entries_recurringDay_range" CHECK ("recurringDay" BETWEEN 1 AND 31);
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_amountCents_nonnegative" CHECK ("amountCents" >= 0);
