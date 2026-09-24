-- AlterEnum
ALTER TYPE "InputSource" ADD VALUE 'SHEET';

-- CreateTable
CREATE TABLE "sheet_row_snapshots" (
    "transactionId" UUID NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "sheet_row_snapshots_pkey" PRIMARY KEY ("transactionId")
);

-- CreateTable
CREATE TABLE "trash_entries" (
    "id" SERIAL NOT NULL,
    "payload" JSONB NOT NULL,
    "deletedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trash_entries_pkey" PRIMARY KEY ("id")
);
