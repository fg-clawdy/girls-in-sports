// Media Composition Engine for GIS
// Executes AI-generated composition scripts using ffmpeg and sharp
// No AI here — pure pixel-level execution

import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import sharp from "./sharp-wrapper";
import type { CollageScript, VideoScript } from "./composer";

const OUTPUT_DIR = process.env.COMPOSITION_OUTPUT_DIR || "/tmp/gis-compositions";
const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function getAssetOriginalUrl(assetId: string): string {
  return `${IMMICH_URL}/api/assets/${assetId}/original?key=${IMMICH_KEY}`;
}

async function downloadAsset(assetId: string, destPath: string): Promise<string> {
  const url = getAssetOriginalUrl(assetId);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download asset ${assetId}: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
  return destPath;
}

async function downloadAssets(assetIds: string[], workDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const id of assetIds) {
    const ext = ".jpg"; // We'll detect actual format after download
    const dest = path.join(workDir, `${id}${ext}`);
    try {
      await downloadAsset(id, dest);
      // Detect actual format and rename if needed
      const metadata = await sharp(dest).metadata();
      if (metadata.format && metadata.format !== "jpeg") {
        const newDest = path.join(workDir, `${id}.${metadata.format}`);
        await fs.rename(dest, newDest);
        paths.push(newDest);
      } else {
        paths.push(dest);
      }
    } catch (err) {
      console.warn(`Failed to download asset ${id}:`, err);
    }
  }
  return paths;
}

// ── COLLAGE COMPOSITION ──────────────────────────────────────

export async function executeCollage(
  script: CollageScript,
  resultId: string
): Promise<{ filePath: string; fileName: string; mimeType: string }> {
  const workDir = path.join(OUTPUT_DIR, resultId);
  await ensureDir(workDir);

  const { width, height } = script.dimensions || { width: 2400, height: 3200 };

  // Download all images
  const assetIds = script.images.map((img) => img.assetId);
  const downloadedPaths = await downloadAssets(assetIds, workDir);

  // Build a map of assetId -> local path
  const assetPathMap = new Map<string, string>();
  for (let i = 0; i < assetIds.length; i++) {
    if (i < downloadedPaths.length) {
      assetPathMap.set(assetIds[i], downloadedPaths[i]);
    }
  }

  // Start with white canvas
  let canvas = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: script.backgroundColor || "#FFFFFF",
    },
  }).png();

  // Composite images at specified positions
  const composites: any[] = [];

  for (const img of script.images) {
    const localPath = assetPathMap.get(img.assetId);
    if (!localPath) continue;

    const px = Math.round(img.position.x * width);
    const py = Math.round(img.position.y * height);
    const pw = Math.round(img.position.w * width);
    const ph = Math.round(img.position.h * height);

    // Resize image to fit the slot
    const resized = await sharp(localPath)
      .resize(pw, ph, { fit: "cover", position: img.crop === "face" ? "centre" : "centre" })
      .toBuffer();

    composites.push({
      input: resized,
      left: px,
      top: py,
    });
  }

  // Apply composites
  const resultBuffer = await sharp(await canvas.toBuffer())
    .composite(composites)
    .png()
    .toBuffer();

  // Save result
  const outputPath = path.join(workDir, "collage.png");
  await fs.writeFile(outputPath, resultBuffer);

  return {
    filePath: outputPath,
    fileName: `${script.title.replace(/[^a-zA-Z0-9]/g, "_")}_collage.png`,
    mimeType: "image/png",
  };
}

// ── VIDEO COMPOSITION ──────────────────────────────────────

function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on("error", reject);
  });
}

export async function executeVideo(
  script: VideoScript,
  resultId: string
): Promise<{ filePath: string; fileName: string; mimeType: string }> {
  const workDir = path.join(OUTPUT_DIR, resultId);
  await ensureDir(workDir);

  // Resolution mapping
  const resolutionMap: Record<string, { w: number; h: number }> = {
    "4K": { w: 3840, h: 2160 },
    "1080p": { w: 1920, h: 1080 },
    "720p": { w: 1280, h: 720 },
  };
  const { w: outW, h: outH } = resolutionMap[script.resolution || "1080p"] || resolutionMap["1080p"];

  // Download video/image assets
  const assetIds = script.clips.map((c) => c.assetId);
  const downloadedPaths = await downloadAssets(assetIds, workDir);

  const assetPathMap = new Map<string, string>();
  for (let i = 0; i < assetIds.length; i++) {
    if (i < downloadedPaths.length) {
      assetPathMap.set(assetIds[i], downloadedPaths[i]);
    }
  }

  // Build individual clip segments
  const segmentPaths: string[] = [];

  for (let i = 0; i < script.clips.length; i++) {
    const clip = script.clips[i];
    const localPath = assetPathMap.get(clip.assetId);
    if (!localPath) continue;

    const segmentPath = path.join(workDir, `segment_${i.toString().padStart(3, "0")}.mp4`);
    segmentPaths.push(segmentPath);

    const duration = clip.duration || 3;
    const transitionDur = clip.transitionDuration || 0.5;

    // Build filter_complex for text overlay
    let filterComplex = "";
    let outputLabel = "[out]";

    if (clip.textOverlay?.text) {
      const text = clip.textOverlay.text.replace(/:/g, "\\:").replace(/'/g, "\\'");
      const pos = clip.textOverlay.position || "bottom";
      const yPos = pos === "top" ? "h*0.1" : pos === "center" ? "h*0.5" : "h*0.85";

      filterComplex = `drawtext=text='${text}':fontcolor=white:fontsize=${Math.floor(outH * 0.05)}:x=(w-text_w)/2:y=${yPos}:box=1:boxcolor=black@0.5:boxborderw=4:enable='between(t,${clip.textOverlay.startAt || 0},${(clip.textOverlay.startAt || 0) + (clip.textOverlay.duration || 2)})'[out];`;
      outputLabel = "[out]";
    }

    // For images, loop them; for videos, trim
    const isImage = localPath.match(/\.(jpg|jpeg|png|webp)$/i);

    if (isImage) {
      // Image -> video segment with zoom/pan if requested
      const zoomExpr = clip.zoom === "in" ? "zoom+zoom*0.001" : clip.zoom === "out" ? "zoom-zoom*0.001" : "1";
      const zoomFilter = `zoompan=z='${zoomExpr}':d=${Math.round(duration * 30)}:s=${outW}x${outH}:fps=30`;

      const args = [
        "-loop", "1",
        "-i", localPath,
        "-vf", `${zoomFilter}${filterComplex ? "," + filterComplex : ""}`,
        "-c:v", "libx264",
        "-t", String(duration + transitionDur),
        "-pix_fmt", "yuv420p",
        "-an",
        segmentPath,
      ];

      await runFFmpeg(args);
    } else {
      // Video -> trim and optionally add text
      const vfParts: string[] = [];
      vfParts.push(`scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`);
      if (filterComplex) {
        vfParts.push(filterComplex.replace("[out]", ""));
      }

      const args = [
        "-i", localPath,
        "-ss", "0",
        "-t", String(duration + transitionDur),
        "-vf", vfParts.join(","),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-an",
        segmentPath,
      ];

      await runFFmpeg(args);
    }
  }

  if (segmentPaths.length === 0) {
    throw new Error("No valid segments could be created");
  }

  // Concatenate segments with transitions
  const concatListPath = path.join(workDir, "concat_list.txt");
  const concatContent = segmentPaths.map((p) => `file '${p}'`).join("\n");
  await fs.writeFile(concatListPath, concatContent);

  const outputPath = path.join(workDir, "video.mp4");

  // Simple concat (crossfade transitions can be added later as enhancement)
  const concatArgs = [
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    outputPath,
  ];

  await runFFmpeg(concatArgs);

  // Add branded outro if specified
  if (script.brandedOutro) {
    const outroPath = path.join(workDir, "outro.mp4");
    const outroText = script.brandedOutro.text.replace(/:/g, "\\:").replace(/'/g, "\\'");
    const outroBg = script.brandedOutro.backgroundColor.replace("#", "0x");

    const outroArgs = [
      "-f", "lavfi",
      "-i", `color=c=${script.brandedOutro.backgroundColor}:s=${outW}x${outH}:d=${script.brandedOutro.duration}`,
      "-vf", `drawtext=text='${outroText}':fontcolor=${script.brandedOutro.textColor}:fontsize=${Math.floor(outH * 0.06)}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.3:boxborderw=6`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      outroPath,
    ];

    await runFFmpeg(outroArgs);

    // Concatenate main video + outro
    const finalListPath = path.join(workDir, "final_list.txt");
    await fs.writeFile(finalListPath, `file '${outputPath}'\nfile '${outroPath}'`);

    const finalOutputPath = path.join(workDir, "video_final.mp4");
    const finalArgs = [
      "-f", "concat",
      "-safe", "0",
      "-i", finalListPath,
      "-c", "copy",
      finalOutputPath,
    ];

    await runFFmpeg(finalArgs);

    // Replace with final
    await fs.rename(finalOutputPath, outputPath);
  }

  return {
    filePath: outputPath,
    fileName: `${script.title.replace(/[^a-zA-Z0-9]/g, "_")}_${script.type}.mp4`,
    mimeType: "video/mp4",
  };
}

// ── MAIN EXECUTOR ──────────────────────────────────────────

export interface CompositionResult {
  resultId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  type: "collage" | "highlight" | "wrapup";
  sizeBytes: number;
}

export async function executeComposition(
  script: CollageScript | VideoScript,
  resultId: string
): Promise<CompositionResult> {
  await ensureDir(OUTPUT_DIR);

  let result: { filePath: string; fileName: string; mimeType: string };

  if (script.type === "collage") {
    result = await executeCollage(script, resultId);
  } else {
    result = await executeVideo(script as VideoScript, resultId);
  }

  const stats = await fs.stat(result.filePath);

  return {
    resultId,
    filePath: result.filePath,
    fileName: result.fileName,
    mimeType: result.mimeType,
    type: script.type,
    sizeBytes: stats.size,
  };
}

export function getOutputPath(resultId: string): string {
  return path.join(OUTPUT_DIR, resultId);
}
