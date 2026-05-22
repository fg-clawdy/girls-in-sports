// ═══════════════════════════════════════════════════════════════════════════════
// US-014: Lightweight Local Pre-Filter Model (ML Phase A)
// Fast, zero-cost image analysis using sharp + heuristics.
// Runs before expensive vision API calls to skip clearly poor images.
// ═══════════════════════════════════════════════════════════════════════════════

import sharp from "./sharp-wrapper";
import { prisma } from "./prisma";

export interface PreFilterFeatures {
  meanBrightness: number; // 0-255
  laplacianVar: number; // variance of Laplacian (higher = sharper)
  edgeDensity: number; // ratio of edge pixels to total
  aspectRatio: number; // width / height
  entropy: number; // image entropy (higher = more detail)
}

export interface PreFilterResult {
  assetId: string;
  eventId: string;
  brightnessScore: number; // 0-100
  blurScore: number; // 0-100
  faceScore: number; // 0-100 (heuristic — no real face model yet)
  actionScore: number; // 0-100 (heuristic based on edge density + entropy)
  compositionScore: number; // 0-100 (aspect ratio + center-weighted brightness)
  overallScore: number; // 0-100 weighted average
  passedFilter: boolean;
  featuresJson: PreFilterFeatures;
}

// Thresholds for passing the pre-filter
const THRESHOLDS = {
  minBrightnessScore: 25, // not too dark
  minBlurScore: 20, // not too blurry
  minOverallScore: 35, // combined gate
};

/**
 * Compute image features using sharp (fast, no external APIs).
 */
export async function analyzeImageFeatures(
  imagePath: string
): Promise<PreFilterFeatures> {
  const img = sharp(imagePath);
  const metadata = await img.metadata();
  const { data, info } = await img
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const totalPixels = width * height;

  // 1. Mean brightness
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) {
    sum += pixels[i];
  }
  const meanBrightness = sum / totalPixels;

  // 2. Laplacian variance (blur detection)
  // Approximate with Sobel-like edge variance
  let edgeSum = 0;
  let edgeSqSum = 0;
  let edgeCount = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const center = pixels[idx];
      const left = pixels[idx - 1];
      const right = pixels[idx + 1];
      const up = pixels[idx - width];
      const down = pixels[idx + width];

      // Simple gradient magnitude approximation
      const gx = Math.abs(right - left);
      const gy = Math.abs(down - up);
      const grad = Math.sqrt(gx * gx + gy * gy);

      edgeSum += grad;
      edgeSqSum += grad * grad;
      edgeCount++;
    }
  }

  const meanEdge = edgeCount > 0 ? edgeSum / edgeCount : 0;
  const laplacianVar =
    edgeCount > 0 ? edgeSqSum / edgeCount - meanEdge * meanEdge : 0;

  // 3. Edge density
  const edgeThreshold = 30; // pixel difference threshold
  let strongEdges = 0;
  for (let i = 0; i < pixels.length; i++) {
    // Simple: compare to neighbors — approximate
    if (i > 0 && Math.abs(pixels[i] - pixels[i - 1]) > edgeThreshold) {
      strongEdges++;
    }
  }
  const edgeDensity = totalPixels > 0 ? strongEdges / totalPixels : 0;

  // 4. Entropy (approximation)
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < pixels.length; i++) {
    histogram[pixels[i]]++;
  }
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const p = histogram[i] / totalPixels;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  return {
    meanBrightness,
    laplacianVar,
    edgeDensity,
    aspectRatio: (metadata.width || 1) / (metadata.height || 1),
    entropy,
  };
}

/**
 * Convert raw features to normalized 0-100 scores.
 */
export function computeScores(features: PreFilterFeatures): Omit<PreFilterResult, "assetId" | "eventId" | "passedFilter"> {
  // Brightness: ideal around 80-180. Penalize underexposed (<40) and overexposed (>230)
  let brightnessScore = 100;
  if (features.meanBrightness < 40) {
    brightnessScore = Math.max(0, features.meanBrightness * 2.5);
  } else if (features.meanBrightness > 230) {
    brightnessScore = Math.max(0, (255 - features.meanBrightness) * 2.5);
  } else {
    brightnessScore = 100 - Math.abs(features.meanBrightness - 128) / 128 * 30;
  }

  // Blur: laplacian variance. Higher = sharper.
  // Typical values: blurry < 100, sharp > 1000
  const blurScore = Math.min(100, features.laplacianVar / 15);

  // Face score: heuristic — higher edge density in center region suggests face
  // Phase A: use edge density as proxy. Phase B: ONNX face detection model.
  const faceScore = Math.min(100, features.edgeDensity * 5000);

  // Action score: high entropy + high edge density = dynamic scene
  const actionScore = Math.min(
    100,
    features.entropy * 8 + features.edgeDensity * 2000
  );

  // Composition: aspect ratio near 1.0 (square) or 1.5 (3:2) is good
  // Also reward center-weighted brightness (not too off-center)
  const arPenalty = Math.abs(features.aspectRatio - 1.33) * 20;
  const compositionScore = Math.max(0, 100 - arPenalty);

  // Overall: weighted average
  const overallScore = Math.round(
    brightnessScore * 0.25 +
    blurScore * 0.25 +
    faceScore * 0.15 +
    actionScore * 0.2 +
    compositionScore * 0.15
  );

  return {
    brightnessScore: Math.round(brightnessScore),
    blurScore: Math.round(blurScore),
    faceScore: Math.round(faceScore),
    actionScore: Math.round(actionScore),
    compositionScore: Math.round(compositionScore),
    overallScore,
    featuresJson: features,
  };
}

/**
 * Quick local-only scoring for a single image file.
 * Returns all dimension scores + overall. No DB persistence.
 */
export async function scoreImageFile(imagePath: string): Promise<{
  brightnessScore: number;
  blurScore: number;
  faceScore: number;
  actionScore: number;
  compositionScore: number;
  overallScore: number;
  passedFilter: boolean;
  featuresJson: PreFilterFeatures;
}> {
  const features = await analyzeImageFeatures(imagePath);
  const scores = computeScores(features);
  return {
    ...scores,
    passedFilter:
      scores.brightnessScore >= THRESHOLDS.minBrightnessScore &&
      scores.blurScore >= THRESHOLDS.minBlurScore &&
      scores.overallScore >= THRESHOLDS.minOverallScore,
  };
}


/**
 * Run the pre-filter on a single image and persist results.
 */
export async function runPreFilter(
  assetId: string,
  eventId: string,
  imagePath: string
): Promise<PreFilterResult> {
  const features = await analyzeImageFeatures(imagePath);
  const scores = computeScores(features);

  const passedFilter =
    scores.brightnessScore >= THRESHOLDS.minBrightnessScore &&
    scores.blurScore >= THRESHOLDS.minBlurScore &&
    scores.overallScore >= THRESHOLDS.minOverallScore;

  const result: PreFilterResult = {
    assetId,
    eventId,
    ...scores,
    passedFilter,
    featuresJson: features,
  };

  // Persist to database
  await prisma.preFilterScore.create({
    data: {
      assetId,
      eventId,
      brightnessScore: result.brightnessScore,
      blurScore: result.blurScore,
      faceScore: result.faceScore,
      actionScore: result.actionScore,
      compositionScore: result.compositionScore,
      overallScore: result.overallScore,
      passedFilter,
      featuresJson: features as any,
    },
  });

  return result;
}

/**
 * Batch pre-filter multiple images and return only those that pass.
 * Useful before expensive vision API calls.
 */
export async function batchPreFilter(
  items: Array<{ assetId: string; eventId: string; imagePath: string }>
): Promise<PreFilterResult[]> {
  const results: PreFilterResult[] = [];

  for (const item of items) {
    try {
      const result = await runPreFilter(item.assetId, item.eventId, item.imagePath);
      results.push(result);
    } catch (err) {
      console.warn(`Pre-filter failed for ${item.assetId}:`, err);
    }
  }

  return results;
}

/**
 * Get the top-N images by pre-filter score for an event.
 * Fast way to narrow down which assets deserve expensive vision analysis.
 */
export async function getTopPreFilteredAssets(
  eventId: string,
  limit: number = 20
): Promise<Array<{ assetId: string; overallScore: number; passedFilter: boolean }>> {
  const records = await prisma.preFilterScore.findMany({
    where: { eventId },
    orderBy: { overallScore: "desc" },
    take: limit,
  });

  return records.map((r) => ({
    assetId: r.assetId,
    overallScore: r.overallScore || 0,
    passedFilter: r.passedFilter,
  }));
}

/**
 * Check if an asset has already been pre-filtered.
 */
export async function isPreFiltered(assetId: string): Promise<boolean> {
  const existing = await prisma.preFilterScore.findFirst({
    where: { assetId },
  });
  return existing !== null;
}
