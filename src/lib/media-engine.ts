// Media Composition Engine for GIS
// Executes AI-generated composition scripts using ffmpeg and sharp
// No AI here — pure pixel-level execution

import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import sharp from "./sharp-wrapper";
import type { CollageScript, VideoScript } from "./composer";
import { analyzeBeats, getBeatAlignedDuration } from "./beat-sync-service";

const OUTPUT_DIR = process.env.COMPOSITION_OUTPUT_DIR || "/tmp/gis-compositions";
const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function getAssetOriginalUrl(assetId: string): string {
  return `${IMMICH_URL}/api/assets/${assetId}/original`;
}

async function downloadAsset(assetId: string, destPath: string): Promise<string> {
  const url = getAssetOriginalUrl(assetId);
  const res = await fetch(url, {
    headers: { "x-api-key": IMMICH_KEY },
  });
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
      // Detect actual format — try sharp first (images), then ffprobe (videos)
      let detectedExt = "jpg";
      let isVideo = false;
      try {
        const metadata = await sharp(dest).metadata();
        if (metadata.format) {
          detectedExt = metadata.format === "jpeg" ? "jpg" : metadata.format;
        }
      } catch {
        // sharp failed — likely a video. Probe with ffprobe.
        const probeResult = await new Promise<string>((resolve) => {
          const proc = spawn("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=noprint_wrappers=1:nokey=1",
            dest,
          ], { stdio: ["ignore", "pipe", "ignore"] });
          let out = "";
          proc.stdout.on("data", (d) => (out += d));
          proc.on("close", () => resolve(out.trim()));
        });
        if (probeResult) {
          isVideo = true;
          detectedExt = "mp4"; // default
          const codec = probeResult.toLowerCase();
          if (codec.includes("prores") || codec.includes("dnxhd")) detectedExt = "mov";
          else if (codec.includes("mpeg2")) detectedExt = "mpg";
          else if (codec.includes("avi")) detectedExt = "avi";
        }
      }
      const newDest = path.join(workDir, `${id}.${detectedExt}`);
      await fs.rename(dest, newDest);
      paths.push(newDest);
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

// Probe actual video duration via ffprobe
async function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", () => {
      const dur = parseFloat(out.trim());
      resolve(isNaN(dur) ? 0 : dur);
    });
  });
}

export async function executeVideo(
  script: VideoScript,
  resultId: string
): Promise<{ filePath: string; fileName: string; mimeType: string }> {
  const workDir = path.join(OUTPUT_DIR, resultId);
  await ensureDir(workDir);

  // Resolution mapping — default vertical 9:16 for mobile-first
  const resolutionMap: Record<string, { w: number; h: number }> = {
    "4K": { w: 2160, h: 3840 },
    "1080p": { w: 1080, h: 1920 },
    "720p": { w: 720, h: 1280 },
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

  // ── BEAT SYNC: Analyze music BPM if musicFile provided ──
  let beatData: { bpm: number; beatTimestamps: number[]; confidence: number } | null = null;
  if (script.musicFile) {
    try {
      beatData = await analyzeBeats(script.musicFile);
      script.bpm = beatData.bpm;
      console.log(`Beat sync: detected ${beatData.bpm} BPM (${beatData.beatTimestamps.length} beats)`);
    } catch (err) {
      console.warn("Beat analysis failed, proceeding without beat sync:", err);
    }
  }

  // Build individual clip segments with proper scaling (preserve aspect ratio + letterbox)
  const segmentPaths: string[] = [];
  const segmentDurations: number[] = []; // actual durations after ffmpeg generation

  for (let i = 0; i < script.clips.length; i++) {
    const clip = script.clips[i];
    const localPath = assetPathMap.get(clip.assetId);
    if (!localPath) continue;

    const segmentPath = path.join(workDir, `segment_${i.toString().padStart(3, "0")}.mp4`);
    segmentPaths.push(segmentPath);

    let duration = clip.duration || 5;

    // Beat sync: adjust duration to land on a musical beat
    if (beatData && beatData.beatTimestamps.length > 0) {
      const maxDuration = clip.duration ? clip.duration * 1.3 : 8; // allow 30% stretch
      const alignedDuration = getBeatAlignedDuration(
        duration,
        beatData.beatTimestamps,
        maxDuration
      );
      duration = alignedDuration;
    }

    // For source videos, clamp duration to actual source length
    const isVideo = !localPath.match(/\.(jpg|jpeg|png|webp)$/i);
    if (isVideo) {
      const sourceDur = await probeDuration(localPath);
      if (sourceDur > 0 && duration > sourceDur) {
        console.log(`Clip ${i}: clamping duration ${duration}s -> ${sourceDur}s (source shorter)`);
        duration = sourceDur;
      }
    }

    // Build filter_complex for text overlay
    let textFilter = "";
    if (clip.textOverlay?.text) {
      const text = clip.textOverlay.text.replace(/:/g, "\\:").replace(/'/g, "\\'");
      const pos = clip.textOverlay.position || "bottom";
      const yPos = pos === "top" ? "h*0.1" : pos === "center" ? "h*0.5" : "h*0.85";
      textFilter = `drawtext=text='${text}':fontcolor=white:fontsize=${Math.floor(outH * 0.05)}:x=(w-text_w)/2:y=${yPos}:box=1:boxcolor=black@0.5:boxborderw=4:enable='between(t,${clip.textOverlay.startAt || 0},${(clip.textOverlay.startAt || 0) + (clip.textOverlay.duration || 2)})'`;
    }

    // For images, loop them; for videos, trim
    const isImage = !isVideo;

    if (isImage) {
      // Image -> video segment with Ken Burns zoom effect (preserve aspect ratio)
      // scale to fit inside output with black letterbox, then optional zoom
      const zoomExpr = clip.zoom === "in" ? "zoom+zoom*0.001" : clip.zoom === "out" ? "zoom-zoom*0.001" : "1";
      const scaleFilter = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`;
      const zoomFilter = clip.zoom && clip.zoom !== "none"
        ? `zoompan=z='${zoomExpr}':d=${Math.round(duration * 30)}:s=${outW}x${outH}:fps=30`
        : "";

      const vfChain = [scaleFilter, zoomFilter, textFilter].filter(Boolean).join(",");

      const args = [
        "-loop", "1",
        "-i", localPath,
        "-vf", vfChain,
        "-c:v", "libx264",
        "-t", String(duration),
        "-pix_fmt", "yuv420p",
        "-an",
        segmentPath,
      ];

      await runFFmpeg(args);
    } else {
      // Video -> trim, scale with letterbox, optional text
      const vfParts: string[] = [];
      vfParts.push(`scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`);
      if (textFilter) {
        vfParts.push(textFilter);
      }

      const args = [
        "-i", localPath,
        "-ss", "0",
        "-t", String(duration),
        "-vf", vfParts.join(","),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-an",
        segmentPath,
      ];

      await runFFmpeg(args);
    }

    // Probe actual duration of the generated segment
    const actualDur = await probeDuration(segmentPath);
    segmentDurations.push(actualDur > 0 ? actualDur : duration);
  }
  if (segmentPaths.length === 0) {
    throw new Error("No valid segments could be created");
  }

  // Crossfade concatenation using xfade
  const outputPath = path.join(workDir, "video.mp4");
  const transitionDur = 0.5; // seconds

  if (segmentPaths.length === 1) {
    // Single clip — just copy
    await runFFmpeg(["-i", segmentPaths[0], "-c", "copy", "-an", outputPath]);
  } else {
    // Build xfade filter_complex for crossfade between segments
    // No trimming — each segment stays full length, xfade handles the overlap
    const inputs: string[] = [];
    const filters: string[] = [];

    for (let i = 0; i < segmentPaths.length; i++) {
      inputs.push("-i", segmentPaths[i]);
    }

    let prevLabel = "0:v";
    let cumulativeOffset = 0;

    for (let i = 1; i < segmentPaths.length; i++) {
      const prevDur = segmentDurations[i - 1] || 5;
      cumulativeOffset += Math.max(0.1, prevDur - transitionDur);

      const outLabel = i === segmentPaths.length - 1 ? "outv" : `tmp${i}`;
      filters.push(
        `[${prevLabel}][${i}:v]xfade=transition=fade:duration=${transitionDur}:offset=${cumulativeOffset}[${outLabel}];`
      );
      prevLabel = outLabel;
    }

    const filterStr = filters.join("");
    const xfadeArgs = [
      ...inputs,
      "-filter_complex", filterStr,
      "-map", "[outv]",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      outputPath,
    ];

    await runFFmpeg(xfadeArgs);
  }

  // Add branded outro if specified
  if (script.brandedOutro) {
    const outroPath = path.join(workDir, "outro.mp4");
    const outroText = script.brandedOutro.text.replace(/:/g, "\\:").replace(/'/g, "\\'");

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

    // Concatenate main video + outro with crossfade
    const finalOutputPath = path.join(workDir, "video_final.mp4");
    const outroFadeArgs = [
      "-i", outputPath,
      "-i", outroPath,
      "-filter_complex", `[0:v][1:v]xfade=transition=fade:duration=0.5:offset=${script.totalDuration || 0}[outv]`,
      "-map", "[outv]",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      finalOutputPath,
    ];

    await runFFmpeg(outroFadeArgs);

    // Replace with final
    await fs.rename(finalOutputPath, outputPath);
  }

  // Add background music if specified
  if (script.musicFile) {
    try {
      await fs.access(script.musicFile);
      const finalWithMusicPath = path.join(workDir, "video_with_music.mp4");
      const totalDur = script.totalDuration + (script.brandedOutro?.duration || 0);

      // Loop/trim music to match video, fade in/out, lower volume so it doesn't overpower
      const musicArgs = [
        "-i", outputPath,
        "-i", script.musicFile,
        "-filter_complex",
        `[1:a]aloop=loop=-1:size=2e+09,atrim=start=0:end=${totalDur},afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(0, totalDur - 3)}:d=3,volume=0.25[a]`,
        "-map", "0:v",
        "-map", "[a]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        finalWithMusicPath,
      ];

      await runFFmpeg(musicArgs);
      await fs.rename(finalWithMusicPath, outputPath);
    } catch {
      console.warn("Music file not found or unreadable, skipping:", script.musicFile);
    }
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
