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

import { analyzeVideoAudio, AudioAnalysisResult } from "@/lib/audio-analysis";

// Need these for route code
const { spawn } = childProcess;
const { mkdtemp, writeFile, readFile, unlink, rmdir } = fsPromises;
const path = pathModule;
const os = osModule;

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH VISION RANKING — Variable frame density: dense in core, sparse at edges
// ═══════════════════════════════════════════════════════════════════════════════

const BATCH_SIZE = 3;
const EDGE_SECONDS_PER_FRAME = 2.0;   // Slower sampling at edges (intro/outro)
const CORE_SECONDS_PER_FRAME = 1.0;   // Faster sampling in core content
const MIN_VIDEO_FRAMES = 3;
const MAX_VIDEO_FRAMES = 24;           // Slightly higher cap since core is denser

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
/**
 * Extract frames with variable density: more frames in the core (middle 60%),
 * fewer frames at the edges (first/last 20%). This captures the best content
 * while avoiding intro/outro noise.
 */
function computeVariableDensityTimestamps(durationSec: number): number[] {
  const edgeStartEnd = durationSec * 0.2; // First and last 20%
  const coreStart = edgeStartEnd;
  const coreEnd = durationSec - edgeStartEnd;
  const coreDuration = coreEnd - coreStart;

  // Calculate how many frames each zone gets
  const edgeFrameCount = Math.max(1, Math.floor(edgeStartEnd / EDGE_SECONDS_PER_FRAME));
  const coreFrameCount = Math.max(2, Math.floor(coreDuration / CORE_SECONDS_PER_FRAME));

  // Ensure total doesn't exceed max
  let totalFrames = edgeFrameCount * 2 + coreFrameCount;
  if (totalFrames > MAX_VIDEO_FRAMES) {
    // Reduce proportionally, but keep at least 2 core frames
    const scale = MAX_VIDEO_FRAMES / totalFrames;
    const scaledCore = Math.max(2, Math.floor(coreFrameCount * scale));
    const remaining = MAX_VIDEO_FRAMES - scaledCore;
    const scaledEdge = Math.max(1, Math.floor(remaining / 2));
    totalFrames = scaledEdge * 2 + scaledCore;
  }
  if (totalFrames < MIN_VIDEO_FRAMES) {
    totalFrames = MIN_VIDEO_FRAMES;
  }

  const timestamps: number[] = [];

  // Edge zone: first 20% (frames spread across 0 to edgeStartEnd)
  for (let i = 0; i < edgeFrameCount; i++) {
    const pct = (i + 1) / (edgeFrameCount + 1);
    timestamps.push(edgeStartEnd * pct * 0.8); // slightly bias away from very start
  }

  // Core zone: middle 60% (denser sampling)
  for (let i = 0; i < coreFrameCount; i++) {
    const pct = (i + 1) / (coreFrameCount + 1);
    timestamps.push(coreStart + coreDuration * pct);
  }

  // Edge zone: last 20% (frames spread across coreEnd to duration)
  for (let i = 0; i < edgeFrameCount; i++) {
    const pct = (i + 1) / (edgeFrameCount + 1);
    timestamps.push(coreEnd + edgeStartEnd * pct * 0.2); // slightly bias away from very end
  }

  return timestamps.sort((a, b) => a - b);
}

async function extractVideoFrames(
  localVideoPath: string,
  assetId: string,
  durationSec: number
): Promise<{ assetId: string; url: string; frameIndex: number; timestamp: number }[]> {
  const timestamps = computeVariableDensityTimestamps(durationSec);
  const frameCount = timestamps.length;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gis-frames-"));
  const framePaths: string[] = [];

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
    // PHASE 1: Build analysis item list (images = 1 item, videos = N frames + audio)
    // ═══════════════════════════════════════════════════════════════════════
    const analysisItems: AnalysisItem[] = [];
    const assetFrameCounts: Record<string, number> = {};
    const audioResults: Record<string, AudioAnalysisResult> = {};

    for (const id of assetIds) {
      const type = assetTypes[id] || "IMAGE";
      if (type === "VIDEO") {
        const duration = assetDurations[id] || 5; // fallback 5s if unknown
        // Estimate frame count using same variable-density logic as extraction
        const edgeStartEnd = duration * 0.2;
        const coreDuration = duration - edgeStartEnd * 2;
        const edgeCount = Math.max(1, Math.floor(edgeStartEnd / EDGE_SECONDS_PER_FRAME));
        const coreCount = Math.max(2, Math.floor(coreDuration / CORE_SECONDS_PER_FRAME));
        const frameCount = Math.min(Math.max(edgeCount * 2 + coreCount, MIN_VIDEO_FRAMES), MAX_VIDEO_FRAMES);
        assetFrameCounts[id] = frameCount;

        try {
          // Download video once, use for both frame extraction + audio analysis
          const videoUrl = getAssetOriginalUrl(id);
          const localPath = await downloadVideoToTemp(videoUrl, apiKey);

          // Run vision frame extraction + audio STT in parallel
          const [frames, audioResult] = await Promise.all([
            extractVideoFrames(localPath, id, duration),
            analyzeVideoAudio(localPath, id),
          ]);

          audioResults[id] = audioResult;

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

          // Remove temp video file immediately after both extractions
          await unlink(localPath).catch(() => {});
        } catch (err: any) {
          console.error(`Video analysis failed for ${id}:`, err.message);
          // Fallback: use thumbnail as single frame, no audio
          assetFrameCounts[id] = 1;
          analysisItems.push({
            assetId: id,
            url: getAssetThumbnailUrl(id),
            isFrame: false,
          });
          audioResults[id] = {
            assetId: id,
            transcript: "",
            segments: [],
            audioScore: 0,
            keywordHits: [],
            keywordCount: 0,
            error: err instanceof Error ? err.message : "Analysis failed",
          };
        }
      } else {
        // Image: single item, no audio
        assetFrameCounts[id] = 1;
        analysisItems.push({
          assetId: id,
          url: getAssetPreviewUrl(id),
          isFrame: false,
        });
      }
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
    // PHASE 3: Compute final weighted scores (vision + audio blend)
    // ═══════════════════════════════════════════════════════════════════════
    const finalScores: {
      assetId: string;
      score: number;
      rank: number;
      reasons: string[];
      framesAnalyzed: number;
      weighting: string;
      audioScore?: number;
      transcriptPreview?: string;
      keywordHits?: string[];
    }[] = [];

    // Vision + Audio blending weights
    const VISION_WEIGHT = 0.7;
    const AUDIO_WEIGHT = 0.3;

    for (const [id, data] of Array.from(accumulator)) {
      if (data.weightSum > 0) {
        const visionScore = data.weightedScoreSum / data.weightSum;
        const audioResult = audioResults[id];
        const hasAudio = audioResult && audioResult.audioScore > 0;

        let blendedScore = visionScore;
        let weightingNote: string;

        if (hasAudio) {
          blendedScore = visionScore * VISION_WEIGHT + audioResult.audioScore * AUDIO_WEIGHT;
          weightingNote = `Vision ${(VISION_WEIGHT * 100).toFixed(0)}% + Audio ${(AUDIO_WEIGHT * 100).toFixed(0)}% — ${audioResult.keywordCount} keyword hits`;
        } else {
          weightingNote = `Vision-only (no audio data)`;
        }

        const uniqueReasons = Array.from(new Set(data.reasons)).slice(0, 5);
        const frameCount = assetFrameCounts[id] || data.frameCount;

        // If audio keywords found, add them as a reason
        if (hasAudio && audioResult.keywordHits.length > 0) {
          uniqueReasons.push(`Audio: ${audioResult.keywordHits.slice(0, 3).join(", ")}`);
        }

        finalScores.push({
          assetId: id,
          score: Math.round(blendedScore),
          rank: 0,
          reasons: uniqueReasons.slice(0, 5),
          framesAnalyzed: frameCount,
          weighting: frameCount > 1 ? `Weighted mean: edge frames ×0.7, core frames ×1.0. ${weightingNote}` : `Single-frame. ${weightingNote}`,
          audioScore: hasAudio ? audioResult.audioScore : undefined,
          transcriptPreview: hasAudio ? audioResult.transcript.slice(0, 80) + (audioResult.transcript.length > 80 ? "..." : "") : undefined,
          keywordHits: hasAudio ? audioResult.keywordHits : undefined,
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
      samplingStrategy:
        "Variable density: edge zones (first/last 20%) at 1 frame / 2.0s, core (middle 60%) at 1 frame / 1.0s",
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
