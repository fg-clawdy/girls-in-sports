// Scene Detection Service — runs ffmpeg scene detection on uploaded videos
// and persists SceneSegment records to the database.

import { spawn } from "child_process";
import { mkdtemp, writeFile, unlink, rmdir } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { prisma } from "./prisma";
import { detectScenes, Scene } from "./video-segmentation";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

/**
 * Download a video asset from Immich to a temp file.
 * Required because ffmpeg can't send the x-api-key header.
 */
async function downloadVideoToTemp(assetId: string): Promise<string> {
  const url = `${IMMICH_URL}/api/assets/${assetId}/original`;
  const res = await fetch(url, {
    headers: { "x-api-key": IMMICH_KEY },
  });

  if (!res.ok) {
    throw new Error(`Failed to download asset ${assetId}: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gis-video-"));
  const tmpPath = path.join(tmpDir, `${assetId}.mp4`);
  await writeFile(tmpPath, buffer);

  return tmpPath;
}

/**
 * Get video duration via ffprobe.
 */
function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);

    let output = "";
    ffprobe.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

    ffprobe.on("close", () => {
      const duration = parseFloat(output.trim());
      resolve(isNaN(duration) ? 0 : duration);
    });

    ffprobe.on("error", () => resolve(0));
  });
}

/**
 * Process a single video for scene detection and persist results.
 * This is designed to be called asynchronously (fire-and-forget) after upload.
 */
export async function processVideoForScenes(
  assetId: string,
  eventId: string,
  threshold: number = 0.3
): Promise<void> {
  const tmpPath = await downloadVideoToTemp(assetId);
  const tmpDir = path.dirname(tmpPath);

  try {
    // Check total duration
    const totalDuration = await getVideoDuration(tmpPath);
    if (totalDuration < 2) {
      // Too short — skip scene detection, treat as single scene
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

    // Run scene detection
    const scenes = await detectScenes(tmpPath, threshold);

    // Save each scene as a SceneSegment
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
    // Create a fallback single-scene entry so the video isn't orphaned
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
    } catch {
      // Ignore DB write errors
    }
  } finally {
    // Cleanup temp files
    try {
      await unlink(tmpPath);
      await rmdir(tmpDir);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Find all video assets in an event's Immich album that haven't been processed yet,
 * and run scene detection on them.
 * Useful for batch/retroactive processing.
 */
export async function processUnscenedVideosForEvent(
  eventId: string,
  albumId: string
): Promise<{ processed: number; failed: number }> {
  // Get all assets in the album from Immich
  const albumRes = await fetch(`${IMMICH_URL}/api/albums/${albumId}`, {
    headers: { "x-api-key": IMMICH_KEY },
  });

  if (!albumRes.ok) {
    throw new Error(`Failed to fetch album ${albumId}: ${albumRes.status}`);
  }

  const album = await albumRes.json();
  const assets = album.assets || [];

  // Filter to videos only
  const videoAssets = assets.filter((a: any) => a.type === "VIDEO");

  let processed = 0;
  let failed = 0;

  for (const asset of videoAssets) {
    try {
      // Check if already processed
      const existing = await prisma.sceneSegment.findFirst({
        where: { parentId: asset.id },
      });

      if (existing) {
        continue; // Already processed
      }

      await processVideoForScenes(asset.id, eventId);
      processed++;
    } catch {
      failed++;
    }
  }

  return { processed, failed };
}
