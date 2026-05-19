import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
import {
  detectScenes,
  calculateSceneFrameCounts,
  extractFramesAtTimestamps,
  mapAudioToScenes,
  computeSceneAudioScore,
  classifySceneType,
  getSegmentDuration,
  buildProductionSegments,
  type Scene,
  type AudioSegment,
  type SceneScore,
  type ProductionSegment,
} from "@/lib/video-segmentation";

// Need these for route code
const { spawn } = childProcess;
const { mkdtemp, writeFile, readFile, unlink, rmdir, copyFile, mkdir } = fsPromises;
const path = pathModule;
const os = osModule;

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH VISION RANKING — Scene-aware segmentation with multi-segment extraction
// ═══════════════════════════════════════════════════════════════════════════════

const BATCH_SIZE = 3;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Download a video from Immich to a temp file so ffmpeg can process it.
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
 * Convert an image file to a base64 data URL.
 */
async function fileToDataUrl(imagePath: string): Promise<string> {
  const buf = await readFile(imagePath);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

interface FrameItem {
  assetId: string;
  url: string;
  isFrame: boolean;
  frameIndex?: number;
  timestamp?: number;
  duration?: number;
  sceneIndex?: number; // which scene this frame belongs to
}

interface VideoAnalysisContext {
  assetId: string;
  duration: number;
  scenes: Scene[];
  sceneFrameMap: Map<number, number[]>; // sceneIndex -> timestamps
  extractedFrames: Array<{ timestamp: number; imagePath: string }>;
  audioSegments: AudioSegment[];
  tmpDir: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST handler
// ═══════════════════════════════════════════════════════════════════════════════

export async function POST(request: Request) {
  let assetIds: string[] = [];
  let assetTypes: Record<string, "IMAGE" | "VIDEO"> = {};
  let assetDurations: Record<string, number> = {};

  // Track temp resources for cleanup
  const videoContexts: VideoAnalysisContext[] = [];
  const tempFiles: string[] = [];
  // US-008: Track best-scored frame for thumbnail auto-select
  let bestFrame: { assetId: string; timestamp: number; score: number; imagePath: string } | null = null;

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
        segments: {},
      });
    }

    const apiKey = process.env.IMMICH_API_KEY || "";

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Build analysis items (images = 1, videos = scene-aware frames)
    // ═══════════════════════════════════════════════════════════════════════
    const analysisItems: FrameItem[] = [];
    const assetFrameCounts: Record<string, number> = {};
    const audioResults: Record<string, AudioAnalysisResult> = {};

    for (const id of assetIds) {
      const type = assetTypes[id] || "IMAGE";

      if (type === "VIDEO") {
        const duration = assetDurations[id] || 5;

        try {
          // Download video once
          const videoUrl = getAssetOriginalUrl(id);
          const localPath = await downloadVideoToTemp(videoUrl, apiKey);
          tempFiles.push(localPath);

          // Parallel: scene detection + audio analysis
          const [scenes, audioResult] = await Promise.all([
            detectScenes(localPath, 0.3),
            analyzeVideoAudio(localPath, id),
          ]);

          audioResults[id] = audioResult;

          // Calculate frame counts per scene
          const frameCounts = calculateSceneFrameCounts(scenes, 2, 12, 1.5);

          // Build timestamp list per scene
          const sceneFrameMap = new Map<number, number[]>();
          const allTimestamps: number[] = [];

          for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const count = frameCounts.get(i) || 3;
            const timestamps: number[] = [];

            for (let f = 0; f < count; f++) {
              const t = scene.startTime + (scene.duration * (f + 1)) / (count + 1);
              timestamps.push(t);
              allTimestamps.push(t);
            }

            sceneFrameMap.set(i, timestamps);
          }

          // Extract frames
          const tmpDir = await mkdtemp(path.join(os.tmpdir(), `gis-seg-${id}-`));
          const extractedFrames = await extractFramesAtTimestamps(
            localPath,
            allTimestamps,
            id
          );

          // Convert to data URLs and build analysis items
          for (const frame of extractedFrames) {
            // Find which scene this frame belongs to
            let sceneIndex = 0;
            for (let i = 0; i < scenes.length; i++) {
              if (frame.timestamp >= scenes[i].startTime && frame.timestamp < scenes[i].endTime) {
                sceneIndex = i;
                break;
              }
            }

            const dataUrl = await fileToDataUrl(frame.imagePath);
            analysisItems.push({
              assetId: id,
              url: dataUrl,
              isFrame: true,
              timestamp: frame.timestamp,
              duration,
              sceneIndex,
            });
          }

          assetFrameCounts[id] = extractedFrames.length;

          // Store context for later phase
          videoContexts.push({
            assetId: id,
            duration,
            scenes,
            sceneFrameMap,
            extractedFrames,
            audioSegments: audioResult.segments || [],
            tmpDir,
          });

          // Clean up video file immediately
          await unlink(localPath).catch(() => {});
          tempFiles.splice(tempFiles.indexOf(localPath), 1);
        } catch (err: any) {
          console.error(`Video analysis failed for ${id}:`, err.message);
          // Fallback: single thumbnail
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
        // Image: single item
        assetFrameCounts[id] = 1;
        analysisItems.push({
          assetId: id,
          url: getAssetPreviewUrl(id),
          isFrame: false,
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Batch vision analysis
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

    // Accumulator: per-asset per-scene frame scores
    const frameScoreAccumulator = new Map<
      string,
      Map<number, { scores: number[]; reasons: string[] }>
    >();

    for (const id of assetIds) {
      frameScoreAccumulator.set(id, new Map());
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

        // Map scores back to scenes by position
        for (let i = 0; i < result.scores.length && i < batch.length; i++) {
          const score = result.scores[i];
          const item = batch[i];
          const sceneMap = frameScoreAccumulator.get(score.assetId);
          if (!sceneMap || item.sceneIndex === undefined) continue;

          if (!sceneMap.has(item.sceneIndex)) {
            sceneMap.set(item.sceneIndex, { scores: [], reasons: [] });
          }
          const sceneData = sceneMap.get(item.sceneIndex)!;
          sceneData.scores.push(score.score);
          sceneData.reasons.push(...score.reasons);

          // US-008: Track best-scored individual frame
          if (score.score > (bestFrame?.score ?? 0)) {
            const ctx = videoContexts.find((c) => c.assetId === item.assetId);
            const frame = ctx?.extractedFrames.find((f) => f.timestamp === item.timestamp);
            if (frame) {
              bestFrame = {
                assetId: item.assetId,
                timestamp: item.timestamp,
                score: score.score,
                imagePath: frame.imagePath,
              };
            }
          }
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
    // PHASE 3: Build scene scores and production segments
    // ═══════════════════════════════════════════════════════════════════════
    const assetSegments: Record<string, ProductionSegment[]> = {};
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
      segments?: ProductionSegment[];
    }[] = [];

    // Vision + Audio blending weights
    const VISION_WEIGHT = 0.5;
    const AUDIO_WEIGHT = 0.3;
    const MOTION_WEIGHT = 0.2;

    for (const ctx of videoContexts) {
      const { assetId, scenes, sceneFrameMap, audioSegments } = ctx;
      const sceneMap = frameScoreAccumulator.get(assetId);
      const audioResult = audioResults[assetId];

      // Build audio-by-scene
      const audioByScene = mapAudioToScenes(scenes, audioSegments);

      // Build SceneScore[] with vision + audio + motion
      const sceneScores: SceneScore[] = scenes.map((scene, i) => {
        const sceneAudio = audioByScene.get(i) || { segments: [], keywordHits: [], avgConfidence: 0 };
        const { score: audioScore, keywordCount } = computeSceneAudioScore(sceneAudio, scene.duration);

        // Vision: average frame scores for this scene
        let visionScore = 0;
        let frameCount = 0;
        const allReasons: string[] = [];

        const frameData = sceneMap?.get(i);
        if (frameData && frameData.scores.length > 0) {
          visionScore = frameData.scores.reduce((a, b) => a + b, 0) / frameData.scores.length;
          frameCount = frameData.scores.length;
          allReasons.push(...frameData.reasons);
        }

        const topReasons = Array.from(new Set(allReasons)).slice(0, 3);

        // Combined score
        const combinedScore = Math.round(
          visionScore * VISION_WEIGHT +
          audioScore * AUDIO_WEIGHT +
          scene.avgMotion * 100 * MOTION_WEIGHT
        );

        return {
          sceneIndex: i,
          visionScore: Math.round(visionScore),
          audioScore,
          motionScore: scene.avgMotion,
          combinedScore,
          frameCount,
          keywordHits: sceneAudio.keywordHits,
          topReasons,
        };
      });

      // Build production segments
      const segments = buildProductionSegments(assetId, scenes, sceneScores, 55);
      assetSegments[assetId] = segments;

      // Asset-level score: best segment score, or average of top 2
      let assetScore = 50;
      if (segments.length > 0) {
        assetScore = segments.length === 1
          ? segments[0].score
          : Math.round((segments[0].score + segments[1].score) / 2);
      }

      // Build reasons from segments
      const allReasons: string[] = segments.flatMap((s) => s.reasons);
      const uniqueReasons = Array.from(new Set(allReasons)).slice(0, 5);

      if (segments.length > 0) {
        uniqueReasons.unshift(`${segments.length} production segment${segments.length > 1 ? "s" : ""} found`);
      }

      const hasAudio = audioResult && audioResult.audioScore > 0;

      finalScores.push({
        assetId,
        score: assetScore,
        rank: 0,
        reasons: uniqueReasons,
        framesAnalyzed: assetFrameCounts[assetId] || 0,
        weighting: `Scene-aware: ${scenes.length} scenes, ${VISION_WEIGHT * 100}% vision + ${AUDIO_WEIGHT * 100}% audio + ${MOTION_WEIGHT * 100}% motion`,
        audioScore: hasAudio ? audioResult.audioScore : undefined,
        transcriptPreview: hasAudio ? audioResult.transcript.slice(0, 80) + (audioResult.transcript.length > 80 ? "..." : "") : undefined,
        keywordHits: hasAudio ? audioResult.keywordHits : undefined,
        segments,
      });
    }

    // Add image scores (single-frame, no segments)
    for (const id of assetIds) {
      if (assetTypes[id] !== "VIDEO" && !finalScores.some((s) => s.assetId === id)) {
        const sceneMap = frameScoreAccumulator.get(id);
        let score = 50;
        let reasons: string[] = ["Image asset — single-frame analysis"];

        if (sceneMap) {
          const scene0 = sceneMap.get(0);
          if (scene0 && scene0.scores.length > 0) {
            score = Math.round(scene0.scores.reduce((a, b) => a + b, 0) / scene0.scores.length);
            reasons = Array.from(new Set(scene0.reasons)).slice(0, 5);
          }
        }

        finalScores.push({
          assetId: id,
          score,
          rank: 0,
          reasons,
          framesAnalyzed: 1,
          weighting: "Single-frame image analysis",
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

    // US-008: Save best-scored frame as event thumbnail
    if (bestFrame && eventId) {
      try {
        const thumbsDir = path.join(process.env.COMPOSITION_OUTPUT_DIR || "/tmp/gis-compositions", "thumbnails");
        await mkdir(thumbsDir, { recursive: true });
        const ext = path.extname(bestFrame.imagePath);
        const dest = path.join(thumbsDir, `${eventId}_thumb${ext || ".jpg"}`);
        await copyFile(bestFrame.imagePath, dest);
        // Persist relative URL to event
        await prisma.event.update({
          where: { id: eventId },
          data: { thumbnailUrl: `/thumbnails/${eventId}_thumb${ext || ".jpg"}` },
        });
      } catch (thumbErr) {
        console.error("US-008: Failed to save thumbnail:", thumbErr);
      }
    }

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
        "Scene-aware: ffmpeg scene detection + dense per-scene frame sampling (1-2s intervals)",
      weightingStrategy:
        "Combined scoring: 50% vision + 30% audio (STT keywords) + 20% motion (scene intensity). Multi-segment extraction per video.",
      segments: assetSegments,
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
        segments: {},
      },
      { status: 500 }
    );
  } finally {
    // Cleanup all temp files
    for (const file of tempFiles) {
      await unlink(file).catch(() => {});
    }
    for (const ctx of videoContexts) {
      for (const frame of ctx.extractedFrames) {
        await unlink(frame.imagePath).catch(() => {});
      }
      await rmdir(ctx.tmpDir).catch(() => {});
    }
  }
}
