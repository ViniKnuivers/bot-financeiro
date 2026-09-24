-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "creditAdjustmentCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "invoiceMonth" TEXT NOT NULL,
    "paidAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payments_accountId_invoiceMonth_key" ON "invoice_payments"("accountId", "invoiceMonth");

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Adicionado manualmente: o Prisma não expressa CHECK constraints no schema.
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_month_format" CHECK ("invoiceMonth" ~ '^\d{4}-(0[1-9]|1[0-2])$');
