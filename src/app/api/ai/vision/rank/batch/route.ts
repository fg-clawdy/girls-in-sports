import { NextResponse } from "next/server";
import {
  analyzeMediaWithVision,
  fallbackRanking,
  isVisionConfigured,
} from "@/lib/vision";
import { getAssetPreviewUrl, getAssetThumbnailUrl, getAssetOriginalUrl } from "@/lib/immich";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";
import * as pathModule from "path";
import * as osModule from "os";

// Need these for route code
const { spawn } = childProcess;
const { mkdtemp, writeFile, readFile, unlink, rmdir } = fsPromises;
const path = pathModule;
const os = osModule;

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH VISION RANKING — All media analyzed, videos sampled at 1 frame / 1.5s
// ═══════════════════════════════════════════════════════════════════════════════

const BATCH_SIZE = 3;
const SECONDS_PER_FRAME = 1.5;
const MIN_VIDEO_FRAMES = 3;
const MAX_VIDEO_FRAMES = 20;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Download a video from Immich to a temp file so ffmpeg can process it.
 * Immich requires x-api-key header which ffmpeg can't send directly.
 */
async function downloadVideoToTemp(videoUrl: string, apiKey: string): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `gis-video-${Date.now()}.mp4`);
  const res = await fetch(videoUrl, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to download video: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(tmpFile, buffer);
  return tmpFile;
}

/**
 * Extract frames from a local video file using ffmpeg.
 * Returns frame items with data URLs ready for vision model.
 */
async function extractVideoFrames(
  localVideoPath: string,
  assetId: string,
  durationSec: number
): Promise<{ assetId: string; url: string; frameIndex: number; timestamp: number }[]> {
  // Calculate frame count: 1 frame per SECONDS_PER_FRAME, bounded by min/max
  const rawCount = Math.floor(durationSec / SECONDS_PER_FRAME);
  const frameCount = Math.min(Math.max(rawCount, MIN_VIDEO_FRAMES), MAX_VIDEO_FRAMES);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gis-frames-"));
  const framePaths: string[] = [];

  // Spread timestamps evenly across the video, padding away from edges
  const edgePad = Math.min(0.5, durationSec * 0.05); // 0.5s or 5% of duration
  const usableDuration = Math.max(durationSec - edgePad * 2, 1);
  const timestamps: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    const pct = (i + 1) / (frameCount + 1);
    timestamps.push(edgePad + usableDuration * pct);
  }

  // Extract frames with ffmpeg — use fast seek then accurate decode
  await Promise.all(
    timestamps.map((ts, idx) => {
      const outPath = path.join(tmpDir, `${assetId}_f${idx}.jpg`);
      framePaths.push(outPath);
      return new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
          "-ss", String(ts),
          "-i", localVideoPath,
          "-vframes", "1",
          "-q:v", "2",
          "-y",
          outPath,
        ]);
        ffmpeg.on("close", (code: number | null) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg frame ${idx} failed: code ${code}`));
        });
        ffmpeg.on("error", reject);
      });
    })
  );

  // Convert to data URLs
  const frames = await Promise.all(
    framePaths.map(async (fp, idx) => {
      const buf = await readFile(fp);
      const base64 = buf.toString("base64");
      return {
        assetId,
        url: `data:image/jpeg;base64,${base64}`,
        frameIndex: idx,
        timestamp: timestamps[idx],
      };
    })
  );

  // Cleanup
  await Promise.all(framePaths.map((fp) => unlink(fp).catch(() => {})));
  await rmdir(tmpDir).catch(() => {});

  return frames;
}

// ─── Weighting Strategy ───────────────────────────────────────────────────────
// Each frame's weight is based on temporal position:
//   • First 20% and last 20% of video: weight 0.7 (often setup/teardown)
//   • Middle 60%: weight 1.0 (core content)
// This prevents an intro title card or outro from dragging the average down.
function computeFrameWeight(timestamp: number, duration: number): number {
  if (duration <= 0) return 1.0;
  const pct = timestamp / duration;
  if (pct < 0.2 || pct > 0.8) return 0.7;
  return 1.0;
}

interface AnalysisItem {
  assetId: string;
  url: string;
  isFrame: boolean;
  frameIndex?: number;
  timestamp?: number;
  duration?: number; // set for video frames so weight can be computed
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let assetIds: string[] = [];
  let assetTypes: Record<string, "IMAGE" | "VIDEO"> = {};
  let assetDurations: Record<string, number> = {};

  try {
    const body = await request.json();
    assetIds = body.assetIds || [];
    assetTypes = body.assetTypes || {};
    assetDurations = body.assetDurations || {};
    const eventId = body.eventId;

    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      return NextResponse.json(
        { error: "assetIds array required" },
        { status: 400 }
      );
    }

    if (!isVisionConfigured()) {
      return NextResponse.json({
        success: false,
        error: "Vision AI not configured",
        visionConfigured: false,
        scores: fallbackRanking(assetIds).scores,
        topIds: assetIds.slice(0, 10),
        modelUsed: "fallback",
        batches: [],
        totalBatches: 0,
        completedBatches: 0,
        failedBatches: 0,
        totalAssetsAnalyzed: 0,
        assetFrameCounts: {},
      });
    }

    const apiKey = process.env.IMMICH_API_KEY || "";

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Build analysis item list (images = 1 item, videos = N frames)
    // ═══════════════════════════════════════════════════════════════════════
    const analysisItems: AnalysisItem[] = [];
    const assetFrameCounts: Record<string, number> = {};
    const tempVideoFiles: string[] = [];

    for (const id of assetIds) {
      const type = assetTypes[id] || "IMAGE";
      if (type === "VIDEO") {
        const duration = assetDurations[id] || 5; // fallback 5s if unknown
        const frameCount = Math.min(
          Math.max(Math.floor(duration / SECONDS_PER_FRAME), MIN_VIDEO_FRAMES),
          MAX_VIDEO_FRAMES
        );
        assetFrameCounts[id] = frameCount;

        try {
          // Download video, extract frames, cleanup
          const videoUrl = getAssetOriginalUrl(id);
          const localPath = await downloadVideoToTemp(videoUrl, apiKey);
          tempVideoFiles.push(localPath);

          const frames = await extractVideoFrames(localPath, id, duration);
          for (const frame of frames) {
            analysisItems.push({
              assetId: frame.assetId,
              url: frame.url,
              isFrame: true,
              frameIndex: frame.frameIndex,
              timestamp: frame.timestamp,
              duration,
            });
          }

          // Remove temp video file immediately after frame extraction
          await unlink(localPath).catch(() => {});
        } catch (err: any) {
          console.error(`Frame extraction failed for video ${id}:`, err.message);
          // Fallback: use thumbnail as single frame
          assetFrameCounts[id] = 1;
          analysisItems.push({
            assetId: id,
            url: getAssetThumbnailUrl(id),
            isFrame: false,
          });
        }
      } else {
        // Image: single item
        assetFrameCounts[id] = 1;
        analysisItems.push({
          assetId: id,
          url: getAssetPreviewUrl(id),
          isFrame: false,
        });
      }
    }

    // Cleanup any orphaned temp files
    for (const tmpFile of tempVideoFiles) {
      await unlink(tmpFile).catch(() => {});
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Chunk into batches and analyze
    // ═══════════════════════════════════════════════════════════════════════
    const batches = chunkArray(analysisItems, BATCH_SIZE);
    const batchResults: {
      batchIndex: number;
      batchSize: number;
      assetIds: string[];
      status: "pending" | "processing" | "completed" | "failed";
      error?: string;
    }[] = batches.map((batch, idx) => ({
      batchIndex: idx,
      batchSize: batch.length,
      assetIds: Array.from(new Set(batch.map((item) => item.assetId))),
      status: "pending" as const,
    }));

    // Accumulator: per-asset weighted scores
    const accumulator: Map<
      string,
      {
        weightedScoreSum: number;
        weightSum: number;
        reasons: string[];
        batchCount: number;
        frameCount: number;
      }
    > = new Map();

    for (const id of assetIds) {
      accumulator.set(id, {
        weightedScoreSum: 0,
        weightSum: 0,
        reasons: [],
        batchCount: 0,
        frameCount: 0,
      });
    }

    let modelUsed = "unknown";

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      batchResults[batchIdx].status = "processing";

      try {
        const assetUrls = batch.map((item) => ({
          assetId: item.assetId,
          url: item.url,
        }));

        const result = await analyzeMediaWithVision(assetUrls, {
          maxImages: BATCH_SIZE,
        });

        modelUsed = result.modelUsed;

        // Merge scores with temporal weighting
        for (const score of result.scores) {
          const item = batch.find((i) => i.assetId === score.assetId);
          const current = accumulator.get(score.assetId);
          if (!current) continue;

          let weight = 1.0;
          if (item?.isFrame && item.duration && item.timestamp !== undefined) {
            weight = computeFrameWeight(item.timestamp, item.duration);
          }

          current.weightedScoreSum += score.score * weight;
          current.weightSum += weight;
          current.reasons.push(...score.reasons);
          current.batchCount++;
          current.frameCount++;
        }

        batchResults[batchIdx].status = "completed";
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : "Batch analysis failed";
        batchResults[batchIdx].status = "failed";
        batchResults[batchIdx].error = errMsg;
        console.error(`Batch ${batchIdx} failed:`, errMsg);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Compute final weighted scores
    // ═══════════════════════════════════════════════════════════════════════
    const finalScores: {
      assetId: string;
      score: number;
      rank: number;
      reasons: string[];
      framesAnalyzed: number;
      weighting: string;
    }[] = [];

    for (const [id, data] of Array.from(accumulator)) {
      if (data.weightSum > 0) {
        const weightedAvg = data.weightedScoreSum / data.weightSum;
        const uniqueReasons = Array.from(new Set(data.reasons)).slice(0, 5);
        const frameCount = assetFrameCounts[id] || data.frameCount;
        finalScores.push({
          assetId: id,
          score: Math.round(weightedAvg),
          rank: 0,
          reasons: uniqueReasons,
          framesAnalyzed: frameCount,
          weighting:
            frameCount > 1
              ? `Weighted mean: edge frames ×0.7, core frames ×1.0 (${data.frameCount} frames across ${data.batchCount} batch${data.batchCount !== 1 ? "es" : ""})`
              : "Single-frame analysis (thumbnail)",
        });
      }
    }

    // Sort and rank
    finalScores.sort((a, b) => b.score - a.score);
    finalScores.forEach((s, i) => {
      s.rank = i + 1;
    });

    // Fallback for unscored assets
    const scoredIds = new Set(finalScores.map((s) => s.assetId));
    for (const id of assetIds) {
      if (!scoredIds.has(id)) {
        finalScores.push({
          assetId: id,
          score: 50,
          rank: finalScores.length + 1,
          reasons: ["No AI analysis available — default ranking applied"],
          framesAnalyzed: assetFrameCounts[id] || 0,
          weighting: "Fallback (no vision data)",
        });
      }
    }
    finalScores.sort((a, b) => b.score - a.score);
    finalScores.forEach((s, i) => {
      s.rank = i + 1;
    });

    const topIds = finalScores.slice(0, 10).map((s) => s.assetId);
    const completedBatches = batchResults.filter((b) => b.status === "completed").length;
    const failedBatches = batchResults.filter((b) => b.status === "failed").length;

    return NextResponse.json({
      success: true,
      scores: finalScores,
      topIds,
      modelUsed,
      visionConfigured: true,
      eventId: eventId || null,
      batches: batchResults,
      totalBatches: batches.length,
      completedBatches,
      failedBatches,
      totalAssetsAnalyzed: assetIds.length,
      assetFrameCounts,
      secondsPerFrame: SECONDS_PER_FRAME,
      weightingStrategy:
        "Edge frames (first/last 20%) weighted 0.7×, core frames weighted 1.0×. Scores are weighted averages.",
    });
  } catch (error) {
    console.error("Vision batch analysis error:", error);
    const errMsg = error instanceof Error ? error.message : "Analysis failed";
    return NextResponse.json(
      {
        error: errMsg,
        scores: fallbackRanking(assetIds).scores,
        topIds: assetIds.slice(0, 10),
        visionConfigured: isVisionConfigured(),
        batches: [],
        totalBatches: 0,
        completedBatches: 0,
        failedBatches: 0,
        totalAssetsAnalyzed: 0,
        assetFrameCounts: {},
      },
      { status: 500 }
    );
  }
}
