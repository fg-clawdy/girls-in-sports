import { PrismaClient, AssetStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import {
  downloadAssetToFile,
  uploadAssetFromFile,
  addAssetsToAlbum,
} from "../immich";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface IngestClipPayload {
  assetId: string;
  immichAssetId: string;
  eventId: string;
  eventName?: string;
  fileName?: string;
}

const TMP_BASE = "/tmp/gis";
const SCENE_THRESHOLD = 0.3;
const MIN_SCENE_DURATION = 3;
const MAX_SCENE_DURATION = 120;

export async function handleIngestClip(payload: unknown): Promise<void> {
  const pl = payload as IngestClipPayload;
  const { assetId, immichAssetId, eventId } = pl;

  // ── 1. Create temp directory ──
  const tmpDir = join(TMP_BASE, assetId);
  await fs.mkdir(tmpDir, { recursive: true });
  const sourcePath = join(tmpDir, "source");

  try {
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

    // ── 4. Scene detection ──
    if (durationSeconds > 60) {
      const scenes = await detectScenes(sourcePath, durationSeconds);
      const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { immichAlbumId: true },
      });
      const albumId = event?.immichAlbumId || "";

      const clipJobs: Array<{
        start: number;
        end: number;
        clipPath: string;
      }> = [];

      for (let i = 0; i < scenes.length; i++) {
        const { start, end } = scenes[i];
        const clipPath = join(tmpDir, `clip_${i}.mp4`);
        await cutClip(sourcePath, clipPath, start, end);
        clipJobs.push({ start, end, clipPath });
      }

      // ── 5. Upload clips to Immich ──
      for (let i = 0; i < clipJobs.length; i++) {
        const { start, end, clipPath } = clipJobs[i];
        const now = new Date().toISOString();
        const clipName = `clip_${i}_${start.toFixed(2)}-${end.toFixed(2)}.mp4`;

        const uploadedImmichId = await uploadAssetFromFile(
          clipPath,
          `${assetId}_clip_${i}`,
          clipName,
          now,
          now,
          "video/mp4"
        );

        if (albumId) {
          await addAssetsToAlbum(albumId, [uploadedImmichId]);
        }

        const clipAsset = await prisma.asset.create({
          data: {
            eventId,
            parentAssetId: assetId,
            immichAssetId: uploadedImmichId,
            type: "CLIP",
            status: AssetStatus.UPLOADED,
            filePath: clipName,
            durationSeconds: end - start,
            sizeBytes: (await fs.stat(clipPath)).size,
          },
        });

        // ── 6. Enqueue SCORE_CLIP job ──
        await prisma.job.create({
          data: {
            type: "SCORE_CLIP",
            payload: JSON.stringify({
              assetId: clipAsset.id,
              immichAssetId: uploadedImmichId,
              eventId,
              eventName: pl.eventName,
              parentJobId: null,
            }),
            status: "QUEUED",
            attempts: 0,
            maxAttempts: 3,
          },
        });
      }
    } else {
      // ── Short video: score directly ──
      await prisma.job.create({
        data: {
          type: "SCORE_CLIP",
          payload: JSON.stringify({
            assetId,
            immichAssetId,
            eventId,
            eventName: pl.eventName,
            parentJobId: null,
          }),
          status: "QUEUED",
          attempts: 0,
          maxAttempts: 3,
        },
      });
    }
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
async function ffprobe(path: string): Promise<{
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,codec_name",
      "-show_entries", "format=duration",
      "-of", "json",
      path,
    ]);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe failed: ${stderr}`));
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] || {};
        const fmt = data.format || {};

        // Parse fps fraction like "30000/1001"
        let fps = 0;
        if (stream.r_frame_rate) {
          const [num, den] = stream.r_frame_rate.split("/").map(Number);
          if (den) fps = num / den;
        }

        resolve({
          duration: parseFloat(fmt.duration || "0"),
          width: stream.width || 0,
          height: stream.height || 0,
          fps: Math.round(fps * 100) / 100,
          codec: stream.codec_name || "",
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ── Scene detection ──
async function detectScenes(
  videoPath: string,
  totalDuration: number
): Promise<Array<{ start: number; end: number }>> {
  const sceneCmd = spawn("ffmpeg", [
    "-i", videoPath,
    "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    "-an",
    "-f", "null",
    "-",
  ]);

  let sceneOutput = "";
  sceneCmd.stderr.on("data", (d) => { sceneOutput += d; });

  await new Promise<void>((resolve, reject) => {
    sceneCmd.on("close", (code) => {
      if (code !== 0) reject(new Error(`Scene detection failed: ${sceneOutput.slice(-500)}`));
      else resolve();
    });
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
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-ss", start.toFixed(3),
      "-to", end.toFixed(3),
      "-i", sourcePath,
      "-c", "copy",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg cut failed: ${stderr.slice(-500)}`));
      } else {
        resolve();
      }
    });
  });
}
