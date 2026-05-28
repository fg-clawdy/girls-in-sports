// US-014: centralized quality flag + error recording for every external call failure
// (Immich, ffmpeg/ffprobe, scene detection, uploads). Matches the pattern now used
// in score-clip and required by the JobHandler contract.
import { AssetStatus } from "@prisma/client";
import { spawnLimitedFfmpeg, spawnLimitedFfprobe, collectStdout, collectStderr } from "../ffmpeg-utils";
import { promises as fs } from "fs";
import { join } from "path";
import { prisma } from "../prisma";
import {
  downloadAssetToFile,
  uploadAssetFromFile,
  addAssetsToAlbum,
} from "../immich";
import { recordQualityFlags, recordJobError } from "./quality-tracking";
import { transcribeVideo, TranscriptionResult } from "../transcription";
import { enqueueJob, JobType } from "../job-worker";
import { analyzeAndSegment } from "../scene-detection-service";
import { ActivityTag, ACTIVITY_TAG_VALUES } from "../activity-tags";

interface IngestClipPayload {
  assetId: string;
  immichAssetId: string;
  eventId: string;
  eventName?: string;
  fileName?: string;
  activityTags?: string[];
}

const TMP_BASE = "/tmp/gis";
const SCENE_THRESHOLD = 0.3;
const MIN_SCENE_DURATION = 3;
const MAX_SCENE_DURATION = 120;

// US-014: signature updated to receive jobId (worker now passes it for every handler).
// All external calls (Immich, ffprobe, ffmpeg scene/cut) are now wrapped so that
// failures are recorded to Job.error + qualityFlags, circuit breakers trigger,
// and users see actionable messages instead of silent failures.
export async function handleIngestClip(args: { payload: unknown; jobId: string }): Promise<void> {
  const pl = args.payload as IngestClipPayload;
  const jobId = args.jobId;
  const { assetId, immichAssetId, eventId } = pl;

  // ── 1. Create temp directory ──
  const tmpDir = join(TMP_BASE, assetId);
  await fs.mkdir(tmpDir, { recursive: true });
  const sourcePath = join(tmpDir, "source");

  try {
    // ── 1a. Idempotency guard ──
    const existingChildren = await prisma.asset.count({
      where: { parentAssetId: assetId, type: "CLIP" },
    });
    if (existingChildren > 0) {
      await recordQualityFlags(jobId, "ingest-clip", {
        skipped: true,
        reason: "child_assets_already_exist",
        childCount: existingChildren,
      });
      return;
    }

    // ── 2. Download from Immich ──
    await downloadAssetToFile(immichAssetId, sourcePath);

    // ── 3. Run ffprobe ──
    const probe = await ffprobe(sourcePath);
    const durationSeconds = probe.duration || 0;
    const widthPx = probe.width || 0;
    const heightPx = probe.height || 0;
    const fps = probe.fps || 0;
    const codec = probe.codec || "";
    const sizeBytes = (await fs.stat(sourcePath)).size;

    await prisma.asset.update({
      where: { id: assetId },
      data: {
        durationSeconds,
        widthPx,
        heightPx,
        fps,
        codec,
        sizeBytes,
        status: AssetStatus.INGESTING,
      },
    });

    // ── Look up asset type to handle images gracefully ──
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { type: true },
    });

    // ── US-005: read activityTags from Event record ──
    const eventRecord = await prisma.event.findUnique({
      where: { id: eventId },
      select: { activityTags: true },
    });
    const activityTags: string[] = (eventRecord?.activityTags as any) ?? [];

    // Images: skip scene detection and scoring entirely
    if (asset?.type === "SOURCE_IMAGE") {
      await prisma.asset.update({
        where: { id: assetId },
        data: { status: AssetStatus.UPLOADED },
      });
      return;
    }

    // ── 3a. Transcription (S1-03): run STT on source to drive speech segmentation ──
    let txResult: TranscriptionResult | null = null;
    try {
      const result = await transcribeVideo(sourcePath);
      txResult = result;
      // Store full transcript + word-level timestamps on parent Asset
      await prisma.asset.update({
        where: { id: assetId },
        data: {
          transcriptWordsJson: result.words.map((w) => ({
            word: w.word,
            startMs: Math.round(w.start * 1000),
            endMs: Math.round(w.end * 1000),
            speakerLabel: result.speakerSegments.find(
              (s) => w.start >= s.start && w.end <= s.end
            )?.speakerLabel || null,
          })) as any,
        },
      });
    } catch (txErr) {
      console.warn("[ingest-clip] Transcription failed (continuing with scene-only segmentation):", txErr);
    }

    // ── 4. AI-first segmentation (US-010) or direct score for short clips ──
    if (durationSeconds > 20) {
      // Normalize activityTags to canonical ActivityTag values
      const normalizedTags: ActivityTag[] = activityTags
        .map((t) => t.toLowerCase())
        .filter((t): t is ActivityTag => ACTIVITY_TAG_VALUES.includes(t as ActivityTag));

      const segmentResult = await analyzeAndSegment(
        assetId,
        sourcePath,
        eventId,
        normalizedTags,
        immichAssetId
      );

      // Enqueue SCORE_CLIP for each child clip created by analyzeAndSegment
      const childClips = await prisma.asset.findMany({
        where: { parentAssetId: assetId, type: "CLIP" },
        select: { id: true, immichAssetId: true },
      });

      for (const child of childClips) {
        await enqueueJob(JobType.SCORE_CLIP, {
          assetId: child.id,
          immichAssetId: child.immichAssetId,
          eventId,
          eventName: pl.eventName,
          activityTags,
        });
      }
    } else {
      // ── Short video: score directly ──
      await enqueueJob(JobType.SCORE_CLIP, {
        assetId,
        immichAssetId,
        eventId,
        eventName: pl.eventName,
        activityTags,
      });
    }

    // US-014 success path: record that ingest completed (even if some child clips had issues downstream)
    await recordQualityFlags(jobId, "ingest-clip", { failed: false });

    // Mark source video as fully ingested
    await prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.UPLOADED },
    });
  } catch (err) {
    // US-014: every failure path now records exact error + quality flag so the
    // user sees a clear message, the circuit breaker can trip, and the worker
    // can decide retry vs. permanent FAILED.
    await recordJobError(jobId, err as Error, "ingest-clip");
    throw err;
  } finally {
    // ── 7. Clean up temp files ──
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

// ── ffprobe helper ──
async function ffprobe(filePath: string): Promise<{
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
}> {
  const { proc } = spawnLimitedFfprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,codec_name",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ], { logTag: "ingest-clip:ffprobe" });

  const outStr = await collectStdout(proc as { stdout: NodeJS.ReadableStream });
  const data = JSON.parse(outStr);
  const stream = data.streams?.[0] || {};
  const fmt = data.format || {};

  let fps = 0;
  if (stream.r_frame_rate) {
    const [num, den] = stream.r_frame_rate.split("/").map(Number);
    if (den) fps = num / den;
  }

  return {
    duration: parseFloat(fmt.duration || "0"),
    width: stream.width || 0,
    height: stream.height || 0,
    fps: Math.round(fps * 100) / 100,
    codec: stream.codec_name || "",
  };
}

// ── Scene detection ──
async function detectScenes(
  videoPath: string,
  totalDuration: number
): Promise<Array<{ start: number; end: number }>> {
  const SCENE_TIMEOUT_MS = 600_000; // 10 minutes

  const { proc: sceneCmd } = spawnLimitedFfmpeg([
    "-i", videoPath,
    "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    "-an",
    "-f", "null",
    "-",
  ], { nice: 15, timeoutMs: SCENE_TIMEOUT_MS, logTag: "ingest-clip:detectScenes" });

  const sceneOutput = await collectStderr(sceneCmd);
  await new Promise<void>((resolve, reject) => {
    sceneCmd.on("close", (code) => {
      if (code !== 0) reject(new Error(`Scene detection failed: ${sceneOutput.slice(-500)}`));
      else resolve();
    });
    sceneCmd.on("error", reject);
  });

  const timestamps: number[] = [0];
  const ptsRegex = /pts:\s*(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = ptsRegex.exec(sceneOutput)) !== null) {
    // pts_time is not always available; use frame-based estimate with fps
    // Better: parse pts_time from showinfo
  }

  // More robust: parse from showinfo output
  const timeRegex = /pts_time:(\d+\.?\d*)/g;
  const times: number[] = [0];
  let m: RegExpExecArray | null;
  while ((m = timeRegex.exec(sceneOutput)) !== null) {
    times.push(parseFloat(m[1]));
  }

  // Build scene segments with min/max duration constraints
  const scenes: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < times.length; i++) {
    const start = times[i];
    const rawEnd = i + 1 < times.length ? times[i + 1] : totalDuration;
    const duration = rawEnd - start;

    if (duration < MIN_SCENE_DURATION) continue;
    if (duration > MAX_SCENE_DURATION) {
      // Split into chunks of MAX_SCENE_DURATION
      let chunkStart = start;
      while (chunkStart < rawEnd) {
        const chunkEnd = Math.min(chunkStart + MAX_SCENE_DURATION, rawEnd);
        if (chunkEnd - chunkStart >= MIN_SCENE_DURATION) {
          scenes.push({ start: chunkStart, end: chunkEnd });
        }
        chunkStart = chunkEnd;
      }
    } else {
      scenes.push({ start, end: rawEnd });
    }
  }

  // If no scenes detected, return one segment
  if (scenes.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  return scenes;
}

// ── Cut clip with stream copy ──
async function cutClip(
  sourcePath: string,
  outputPath: string,
  start: number,
  end: number
): Promise<void> {
  const CUT_TIMEOUT_MS = 120_000; // 2 minutes

  const { proc } = spawnLimitedFfmpeg([
    "-ss", start.toFixed(3),
    "-to", end.toFixed(3),
    "-i", sourcePath,
    "-c", "copy",
    "-y",
    outputPath,
  ], { nice: 15, timeoutMs: CUT_TIMEOUT_MS, logTag: "ingest-clip:cutClip" });

  return new Promise((resolve, reject) => {
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg cut failed: ${stderr.slice(-500)}`));
      } else {
        resolve();
      }
    });
    proc.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSCRIPT-DRIVEN SEGMENTATION (S1-03)
// Merge ffmpeg scene cuts with STT word-level silence gaps and speaker changes
// to produce refined clip boundaries for speech-dominant content.
// ═══════════════════════════════════════════════════════════════════════════════

interface Scene { start: number; end: number; }

function mergeSegmentBoundaries(
  scenes: Scene[],
  tx: TranscriptionResult,
  totalDuration: number,
): Scene[] {
  const boundaries = new Set<number>([0, totalDuration]);

  // Add all ffmpeg scene boundaries
  for (const s of scenes) {
    boundaries.add(s.start);
    boundaries.add(s.end);
  }

  // Add silence-gap boundaries (gaps ≥ 0.8s between consecutive words)
  const words = tx.words;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= 0.8) {
      boundaries.add(words[i].start);
    }
  }

  // Add speaker-change boundaries
  const speakers = tx.speakerSegments;
  for (let i = 1; i < speakers.length; i++) {
    if (speakers[i].speakerLabel !== speakers[i - 1].speakerLabel) {
      boundaries.add(speakers[i].start);
    }
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const merged: Scene[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const dur = end - start;

    if (dur >= 4) {
      // Keep segments ≥ 4 seconds
      merged.push({ start, end });
    } else if (merged.length > 0) {
      // Merge very short segment into previous one
      merged[merged.length - 1].end = end;
    } else {
      // First segment too short — skip and merge with next
      continue;
    }
  }

  if (merged.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENCY UTILITY
// poolMap runs an async function over an array with bounded concurrency.
// Used for parallel Immich uploads — I/O-bound, no memory pressure from streams.
// ═══════════════════════════════════════════════════════════════════════════════

async function poolMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const currentIdx = idx++;
      results[currentIdx] = await fn(items[currentIdx], currentIdx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
