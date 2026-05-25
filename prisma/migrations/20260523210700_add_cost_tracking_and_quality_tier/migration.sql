-- Safe, idempotent migration to add cost tracking and quality tier columns.
-- These columns were added to schema.prisma after the initial empty 0_init migration
-- (the project previously relied on `prisma db push`).
--
-- This migration uses IF NOT EXISTS / conditional logic so it is safe to run
-- even if some columns already exist on the target database (common after db push).
--
-- Apply with: npx prisma migrate deploy   (recommended for production / CI)
-- or:         npx prisma migrate dev      (for local development)

-- Ensure the QualityTier enum exists (Prisma creates it as a PostgreSQL enum type)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QualityTier') THEN
    CREATE TYPE "QualityTier" AS ENUM ('AMATEUR', 'INTERMEDIATE', 'PROFESSIONAL');
  END IF;
END $$;

-- Add the columns if they do not already exist.
-- Using DOUBLE PRECISION to match Prisma's Float mapping on PostgreSQL.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "qualityTier" "QualityTier" NOT NULL DEFAULT 'PROFESSIONAL';
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "costBudgetUSD" DOUBLE PRECISION;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "currentEstimatedCost" DOUBLE PRECISION DEFAULT 0;