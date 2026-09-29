-- CreateEnum
CREATE TYPE "RecurringMode" AS ENUM ('AUTO', 'REMIND');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "dueDay" INTEGER;

-- AlterTable
ALTER TABLE "recurring_entries" ADD COLUMN     "mode" "RecurringMode" NOT NULL DEFAULT 'AUTO';

-- CreateTable
CREATE TABLE "reminders" (
    "id" SERIAL NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER,
    "category" "Category",
    "dueDate" DATE NOT NULL,
    "remindOn" DATE NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "canceledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminders_remindOn_idx" ON "reminders"("remindOn");

-- Adicionado manualmente: o Prisma não expressa CHECK constraints no schema.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_dueDay_range" CHECK ("dueDay" BETWEEN 1 AND 31);
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_amountCents_positive" CHECK ("amountCents" > 0);
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_remindOn_before_due" CHECK ("remindOn" <= "dueDate");
