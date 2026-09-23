-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('EXPENSE', 'INCOME');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('ALIMENTACAO', 'MERCADO', 'TRANSPORTE', 'MORADIA', 'CONTAS', 'SAUDE', 'EDUCACAO', 'LAZER', 'ASSINATURAS', 'COMPRAS', 'OUTROS', 'SALARIO', 'ESTAGIO', 'FREELA', 'OUTROS_RECEITA');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CREDITO', 'DEBITO', 'DINHEIRO', 'OUTRO');

-- CreateEnum
CREATE TYPE "InputSource" AS ENUM ('TEXT', 'AUDIO');

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "paymentMethod" "PaymentMethod",
    "occurredAt" DATE NOT NULL,
    "rawInput" TEXT NOT NULL,
    "source" "InputSource" NOT NULL,
    "batchId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transactions_batchId_idx" ON "transactions"("batchId");

-- CreateIndex
CREATE INDEX "transactions_createdAt_idx" ON "transactions"("createdAt");

-- CreateIndex
CREATE INDEX "transactions_occurredAt_idx" ON "transactions"("occurredAt");

-- Adicionado manualmente: o Prisma não expressa CHECK constraints no schema.
-- Valor sempre positivo; o sinal vem de "type" (EXPENSE/INCOME).
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amountCents_positive" CHECK ("amountCents" > 0);
