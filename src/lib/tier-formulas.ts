/**
 * Transparent tier formulas for Girls In Sports clip curation.
 * 
 * These formulas replace the old opaque 3-tier LLM scoring.
 * 
 * - momentScore: "Rate the captured moment: faces, emotion, action peak, story, energy"
 * - productionScore: "Rate technical quality: stability, lighting, exposure, framing, noise"
 * 
 * composite = moment * momentWeight + production * productionWeight
 * A clip only passes the tier if BOTH moment >= momentMin AND production >= productionMin.
 */

export interface TierFormula {
  momentWeight: number;
  productionWeight: number;
  momentMin: number;
  productionMin: number;
}

export const TIER_FORMULAS: Record<string, TierFormula> = {
  AMATEUR: {
    momentWeight: 0.7,
    productionWeight: 0.3,
    momentMin: 30,
    productionMin: 15,
  },
  INTERMEDIATE: {
    momentWeight: 0.6,
    productionWeight: 0.4,
    momentMin: 40,
    productionMin: 25,
  },
  PROFESSIONAL: {
    momentWeight: 0.5,
    productionWeight: 0.5,
    momentMin: 50,
    productionMin: 40,
  },
};

export function computeTieredScore(
  momentScore: number | null | undefined,
  productionScore: number | null | undefined,
  tier: string
): { combined: number; passes: boolean } {
  const formula = TIER_FORMULAS[tier] ?? TIER_FORMULAS.PROFESSIONAL;
  const m = momentScore ?? 0;
  const p = productionScore ?? 0;

  const combined = Math.round(m * formula.momentWeight + p * formula.productionWeight);
  const passes = m >= formula.momentMin && p >= formula.productionMin;

  return { combined, passes };
}

/**
 * Legacy fallback composite (for backward compatibility with old clips
 * that only have the old vision/audio/motion scores).
 * Kept here so the old formula is not lost if needed for migration.
 */
export function computeLegacyComposite(
  visionScore: number | null | undefined,
  audioScore: number | null | undefined,
  motionScore: number | null | undefined
): number {
  const v = visionScore ?? 0;
  const a = audioScore ?? 0;
  const m = motionScore ?? 0;
  return Math.round(v * 0.5 + a * 0.3 + m * 0.2);
}