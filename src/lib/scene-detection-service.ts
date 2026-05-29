// Scene Detection Service — AI-first segmentation for Girls In Sports
//
// REFACTOR (US-010): Replaced ffmpeg-scene-first pipeline with AI-first
// candidate windows. Scene detection is now a signal source, not the gate.

import { spawn } from "child_process";
import { mkdtemp, writeFile, unlink, rmdir } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { prisma } from "./prisma";
import { detectScenes, Scene } from "./video-segmentation";
import { computeAudioEnergyProfile, AudioEnergyProfile } from "./ffmpeg-utils";
import { identifyCandidateWindows, buildMotionDensityProfile } from "./candidate-windows";
import { analyzeTemporalInterestingness } from "./ai-interestingness";
import { ActivityTag } from "./activity-tags";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

// ── Low-level helpers (unchanged from before refactor) ───────────────────────

async function downloadVideoToTemp(assetId: string): Promise<string> {
  const url = `${IMMICH_URL}/api/assets/${assetId}/original`;
  const res = await fetch(url, {
    headers: { "x-api-key": IMMICH_KEY },
  });
  if (!res.ok) throw new Error(`Failed to download asset ${assetId}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gis-video-"));
  const tmpPath = path.join(tmpDir, `${assetId}.mp4`);
  await writeFile(tmpPath, buffer);
  return tmpPath;
}

function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    let output = "";
    ffprobe.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    ffprobe.on("close", () => {
      const duration = parseFloat(output.trim());
      resolve(isNaN(duration) ? 0 : duration);
    });
    ffprobe.on("error", () => resolve(0));
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI-FIRST SEGMENTATION (US-010)
// ═══════════════════════════════════════════════════════════════════════════════

interface AnalyzeAndSegmentResult {
  childClipsCreated: number;
  candidateWindows: number;
  avgInterestingness: number;
}

/**
 * AI-first segmentation pipeline.
 *
 * Flow:
 * 1. Audio energy profile (ffmpeg volumedetect)
 * 2. Motion density at low threshold (scene=0.1)
 * 3. Ranked candidate windows via identifyCandidateWindows
 * 4. Extract midpoint frames → analyzeTemporalInterestingness (candidateWindows mode)
 * 5. Boundary refinement (merge <2s, split >30s, snap buffers)
 * 6. Create child CLIP Asset records for high-scoring windows
 *
 * @param sourceAssetId — the parent SOURCE_VIDEO Asset.id
 * @param sourceVideoPath — local file path to the downloaded video
 * @param eventId — the Event.id
 * @param activityTags — event type tags driving the Vision prompt
 * @param immichAssetId — the parent Immich asset id (for child references)
 * @returns summary of created clips
 */
export async function analyzeAndSegment(
  sourceAssetId: string,
  sourceVideoPath: string,
  eventId: string,
  activityTags: ActivityTag[],
  immichAssetId: string,
): Promise<AnalyzeAndSegmentResult> {

  // ── 1. Duration ──
  const duration = await getVideoDuration(sourceVideoPath);
  if (duration < 2) {
    // Too short — create single child covering the whole thing
    await createChildClipAsset({
      eventId,
      parentAssetId: sourceAssetId,
      immichAssetId,
      startTimeMs: 0,
      endTimeMs: Math.round(duration * 1000),
      motionLevel: "LOW",
      dominantMode: "MIXED",
    });
    return { childClipsCreated: 1, candidateWindows: 0, avgInterestingness: 50 };
  }

  // ── 2. Audio energy profile ──
  const audioProfile = await computeAudioEnergyProfile(sourceVideoPath);

  // ── 3. Motion density at low threshold (0.1) ──
  // detectScenes is retained as a signal source, not the segmentation gate (US-012)
  const scenes = await detectScenes(sourceVideoPath, 0.1);
  const motionProfile = buildMotionDensityProfile(scenes, duration);

  // ── 4. Identify candidate windows ──
  const candidateWindows = identifyCandidateWindows(motionProfile, audioProfile, duration);

  if (candidateWindows.length === 0) {
    // Fallback: single window spanning full video
    candidateWindows.push({ startTime: 0, endTime: duration, motionScore: 0, audioScore: 0, combinedScore: 0 });
  }

  // ── 5. Run AI interestingness on candidate windows (midpoint frame per window) ──
  const interestResult = await analyzeTemporalInterestingness(sourceVideoPath, duration, {
    activityTags,
    candidateWindows: candidateWindows.map((w) => ({ startTime: w.startTime, endTime: w.endTime })),
    framesPerWindow: 1, // one midpoint frame per candidate window (US-010 step 4)
  });

  // ── 6. Boundary refinement & child CLIP creation ──
  let childClipsCreated = 0;
  const scoredWindows = interestResult.windows
    .filter((w) => w.interestingnessScore >= 25)
    .sort((a, b) => a.startTime - b.startTime);

  // Merge adjacent windows within 0.2s (overlapping or nearly-touching only)
  const mergedWindows: typeof scoredWindows = [];
  for (const w of scoredWindows) {
    if (mergedWindows.length === 0) {
      mergedWindows.push({ ...w });
      continue;
    }
    const last = mergedWindows[mergedWindows.length - 1];
    if (w.startTime - last.endTime < 0.2) {
      last.endTime = w.endTime;
      last.interestingnessScore = Math.max(last.interestingnessScore, w.interestingnessScore);
    } else {
      mergedWindows.push({ ...w });
    }
  }

  // Enforce min 3s / max 30s, add buffers
  for (const w of mergedWindows) {
    let startMs = Math.max(0, Math.round(w.startTime * 1000) - 500);  // 0.5s pre-roll
    let endMs = Math.min(Math.round(duration * 1000), Math.round(w.endTime * 1000) + 1000); // 1.0s post-roll

    const clipDurMs = endMs - startMs;
    if (clipDurMs < 3000) {
      // Too short — skip (or optionally extend, but skip for now)
      continue;
    }
    if (clipDurMs > 30000) {
      // Too long — cap at 30s
      endMs = startMs + 30000;
    }

    const motionLevel = w.hasAction ? "HIGH" : w.hasPeakMoment ? "MEDIUM" : "LOW";
    const dominantMode = w.hasAction && w.hasEmotion ? "MIXED" : w.hasAction ? "ACTION" : "SPEECH";

    await createChildClipAsset({
      eventId,
      parentAssetId: sourceAssetId,
      immichAssetId,
      startTimeMs: startMs,
      endTimeMs: endMs,
      motionLevel,
      dominantMode,
    });
    childClipsCreated++;
  }

  return {
    childClipsCreated,
    candidateWindows: candidateWindows.length,
    avgInterestingness: interestResult.averageInterestingness,
  };
}

// ── Helper: create child CLIP Asset (same schema as ingest-clip.ts) ──

async function createChildClipAsset(opts: {
  eventId: string;
  parentAssetId: string;
  immichAssetId: string;
  startTimeMs: number;
  endTimeMs: number;
  motionLevel: "LOW" | "MEDIUM" | "HIGH";
  dominantMode: "ACTION" | "SPEECH" | "MIXED" | "MONTAGE";
}) {
  await prisma.asset.create({
    data: {
      eventId: opts.eventId,
      type: "CLIP",
      parentAssetId: opts.parentAssetId,
      immichAssetId: opts.immichAssetId,
      startTimeMs: opts.startTimeMs,
      endTimeMs: opts.endTimeMs,
      durationSeconds: (opts.endTimeMs - opts.startTimeMs) / 1000,
      status: "UPLOADED",
      motionLevel: opts.motionLevel,
      dominantMode: opts.dominantMode,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY PIPELINE (retained for backward compatibility — US-012)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process a single video for scene detection and persist results.
 * @deprecated Superseded by analyzeAndSegment (AI-first segmentation). Kept for traceability.
 */
export async function processVideoForScenes(
  assetId: string,
  eventId: string,
  threshold: number = 0.3
): Promise<void> {
  const tmpPath = await downloadVideoToTemp(assetId);
  const tmpDir = path.dirname(tmpPath);

  try {
    const totalDuration = await getVideoDuration(tmpPath);
    if (totalDuration < 2) {
      await prisma.sceneSegment.create({
        data: {
          parentId: assetId,
          eventId,
          startTime: 0,
          endTime: totalDuration,
          duration: totalDuration,
          motionScore: 0.2,
        },
      });
      return;
    }

    const scenes = await detectScenes(tmpPath, threshold);
    await prisma.$transaction(
      scenes.map((scene) =>
        prisma.sceneSegment.create({
          data: {
            parentId: assetId,
            eventId,
            startTime: scene.startTime,
            endTime: scene.endTime,
            duration: scene.duration,
            motionScore: scene.avgMotion,
          },
        })
      )
    );

    console.log(`Scene detection complete for ${assetId}: ${scenes.length} scenes found`);
  } catch (err) {
    console.error(`Scene detection failed for ${assetId}:`, err);
    try {
      await prisma.sceneSegment.create({
        data: {
          parentId: assetId,
          eventId,
          startTime: 0,
          endTime: 0,
          duration: 0,
          motionScore: 0,
        },
      });
    } catch { /* ignore */ }
  } finally {
    try { await unlink(tmpPath); await rmdir(tmpDir); } catch { /* ignore cleanup */ }
  }
}

/**
 * Find all video assets in an event's Immich album that haven't been processed yet,
 * and run scene detection on them.
 * @deprecated Use analyzeAndSegment instead.
 */
export async function processUnscenedVideosForEvent(
  eventId: string,
  albumId: string
): Promise<{ processed: number; failed: number }> {
  const albumRes = await fetch(`${IMMICH_URL}/api/albums/${albumId}`, {
    headers: { "x-api-key": IMMICH_KEY },
  });
  if (!albumRes.ok) throw new Error(`Failed to fetch album ${albumId}: ${albumRes.status}`);

  const album = await albumRes.json();
  const assets = album.assets || [];
  const videoAssets = assets.filter((a: any) => a.type === "VIDEO");

  let processed = 0;
  let failed = 0;

  for (const asset of videoAssets) {
    try {
      const existing = await prisma.sceneSegment.findFirst({ where: { parentId: asset.id } });
      if (existing) continue;
      await processVideoForScenes(asset.id, eventId);
      processed++;
    } catch {
      failed++;
    }
  }

  return { processed, failed };
}
