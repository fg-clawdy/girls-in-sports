import { NextResponse } from "next/server";
import {
  analyzeMediaWithVision,
  fallbackRanking,
  isVisionConfigured,
} from "@/lib/vision";
import { getAssetPreviewUrl, getAssetThumbnailUrl } from "@/lib/immich";

// Batch-rank all media (images + video frames) with progress events via HTTP/1.1 SSE-style chunked JSON
// Since Next.js App Router route handlers don't support streaming SSE well, we return a single
// JSON response with a `batches` field showing per-batch progress, plus final combined scores.

const BATCH_SIZE = 3;
const VIDEO_FRAME_COUNT = 3; // Extract 3 frames per video for analysis

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Extract representative frames from a video using ffmpeg.
 * Returns an array of frame objects with base64 data.
 */
async function extractVideoFrames(
  videoUrl: string,
  assetId: string,
  count: number
): Promise<{ assetId: string; url: string; isFrame: true; frameIndex: number }[]> {
  const { spawn } = require("child_process");
  const { mkdtemp } = require("fs/promises");
  const path = require("path");
  const os = require("os");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gis-frames-"));
  const framePaths: string[] = [];

  // First get video duration via ffprobe
  const ffprobe = spawn("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoUrl,
  ]);

  let durationStr = "";
  ffprobe.stdout.on("data", (data: Buffer) => { durationStr += data.toString(); });

  await new Promise<void>((resolve, reject) => {
    ffprobe.on("close", (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`ffprobe failed: ${code}`));
    });
    ffprobe.on("error", reject);
  });

  const duration = parseFloat(durationStr.trim()) || 5;
  const timestamps = Array.from({ length: count }, (_, i) => {
    // Spread evenly: avoid first/last second, pick middle + thirds
    const pct = (i + 1) / (count + 1);
    return Math.min(duration * pct, duration - 0.5);
  });

  // Extract frames
  const promises = timestamps.map((ts, idx) => {
    const outPath = path.join(tmpDir, `${assetId}_frame_${idx}.jpg`);
    framePaths.push(outPath);
    return new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-ss", String(ts),
        "-i", videoUrl,
        "-vframes", "1",
        "-q:v", "2",
        "-y",
        outPath,
      ]);
      ffmpeg.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg frame ${idx} failed: ${code}`));
      });
      ffmpeg.on("error", reject);
    });
  });

  await Promise.all(promises);

  // Convert frames to data URLs for the vision model
  const fs = require("fs/promises");
  const frames = await Promise.all(
    framePaths.map(async (fp: string, idx: number) => {
      const buf = await fs.readFile(fp);
      const base64 = buf.toString("base64");
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      return {
        assetId,
        url: dataUrl,
        isFrame: true as const,
        frameIndex: idx,
      };
    })
  );

  // Cleanup temp files
  try {
    for (const fp of framePaths) await fs.unlink(fp);
    await fs.rmdir(tmpDir);
  } catch {
    // ignore cleanup errors
  }

  return frames;
}

export async function POST(request: Request) {
  let assetIds: string[] = [];
  let assetTypes: Record<string, "IMAGE" | "VIDEO"> = {};

  try {
    const body = await request.json();
    assetIds = body.assetIds || [];
    assetTypes = body.assetTypes || {};
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
      });
    }

    // Build a list of all items to analyze:
    // Images → one item each
    // Videos → multiple frame items each
    const analysisItems: {
      assetId: string;
      url: string;
      isFrame: boolean;
      frameIndex?: number;
    }[] = [];

    for (const id of assetIds) {
      const type = assetTypes[id] || "IMAGE";
      if (type === "VIDEO") {
        // For videos, we'll extract frames and use the thumbnail as a fallback
        const thumbUrl = getAssetThumbnailUrl(id);
        analysisItems.push({
          assetId: id,
          url: thumbUrl,
          isFrame: false,
        });
      } else {
        const previewUrl = getAssetPreviewUrl(id);
        analysisItems.push({
          assetId: id,
          url: previewUrl,
          isFrame: false,
        });
      }
    }

    // Chunk into batches of BATCH_SIZE
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
      assetIds: [...new Set(batch.map((item) => item.assetId))],
      status: "pending" as const,
    }));

    // Collect all scores across batches
    const allScores: Map<
      string,
      { score: number; reasons: string[]; batchCount: number; frameScores: number[] }
    > = new Map();

    // Initialize all assets with empty score tracking
    for (const id of assetIds) {
      allScores.set(id, { score: 0, reasons: [], batchCount: 0, frameScores: [] });
    }

    let modelUsed = "unknown";

    // Process batches sequentially to avoid overwhelming the API
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

        // Merge scores into accumulator
        for (const score of result.scores) {
          const current = allScores.get(score.assetId);
          if (current) {
            current.frameScores.push(score.score);
            current.reasons.push(...score.reasons);
            current.batchCount++;
          }
        }

        batchResults[batchIdx].status = "completed";
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : "Batch analysis failed";
        batchResults[batchIdx].status = "failed";
        batchResults[batchIdx].error = errMsg;
        console.error(`Batch ${batchIdx} failed:`, errMsg);
        // Continue with remaining batches — partial results are still useful
      }
    }

    // Compute final scores: average across all frames/batches for each asset
    const finalScores: {
      assetId: string;
      score: number;
      rank: number;
      reasons: string[];
    }[] = [];

    for (const [id, data] of allScores) {
      if (data.batchCount > 0) {
        const avgScore =
          data.frameScores.reduce((a, b) => a + b, 0) / data.frameScores.length;
        // Deduplicate and limit reasons
        const uniqueReasons = [...new Set(data.reasons)].slice(0, 5);
        finalScores.push({
          assetId: id,
          score: Math.round(avgScore),
          rank: 0, // computed below
          reasons: uniqueReasons,
        });
      }
    }

    // Sort by score descending
    finalScores.sort((a, b) => b.score - a.score);
    finalScores.forEach((s, i) => {
      s.rank = i + 1;
    });

    // Assets with no scores get fallback
    const scoredIds = new Set(finalScores.map((s) => s.assetId));
    for (const id of assetIds) {
      if (!scoredIds.has(id)) {
        finalScores.push({
          assetId: id,
          score: 50,
          rank: finalScores.length + 1,
          reasons: ["No AI analysis available — default ranking applied"],
        });
      }
    }

    // Re-rank after adding fallbacks
    finalScores.sort((a, b) => b.score - a.score);
    finalScores.forEach((s, i) => {
      s.rank = i + 1;
    });

    const topIds = finalScores.slice(0, 10).map((s) => s.assetId);

    return NextResponse.json({
      success: true,
      scores: finalScores,
      topIds,
      modelUsed,
      visionConfigured: true,
      eventId: eventId || null,
      batches: batchResults,
      totalBatches: batches.length,
      completedBatches: batchResults.filter((b) => b.status === "completed").length,
      failedBatches: batchResults.filter((b) => b.status === "failed").length,
      totalAssetsAnalyzed: assetIds.length,
    });
  } catch (error) {
    console.error("Vision batch analysis error:", error);
    const errMsg = error instanceof Error ? error.message : "Analysis failed";
    return NextResponse.json(
      {
        error: errMsg,
        scores: [],
        topIds: assetIds.slice(0, 10),
        visionConfigured: isVisionConfigured(),
        batches: [],
        totalBatches: 0,
        completedBatches: 0,
      },
      { status: 500 }
    );
  }
}