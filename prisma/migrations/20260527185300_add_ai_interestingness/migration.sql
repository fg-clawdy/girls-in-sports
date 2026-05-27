-- AlterTable
ALTER TABLE "clip_scores" ADD COLUMN IF NOT EXISTS "interestingness_json" JSONB;
ALTER TABLE "clip_scores" ADD COLUMN IF NOT EXISTS "quote_scores_json" JSONB;
