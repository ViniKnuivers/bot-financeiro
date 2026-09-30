-- CreateTable
CREATE TABLE "goals" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "targetCents" INTEGER NOT NULL,
    "deadline" TEXT,
    "achievedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- Regras que o Prisma não expressa: valor positivo e prazo no formato "YYYY-MM".
ALTER TABLE "goals" ADD CONSTRAINT "goals_target_positive" CHECK ("targetCents" > 0);
ALTER TABLE "goals" ADD CONSTRAINT "goals_deadline_month" CHECK ("deadline" IS NULL OR "deadline" ~ '^\d{4}-(0[1-9]|1[0-2])$');
