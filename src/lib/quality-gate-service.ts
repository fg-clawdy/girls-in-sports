import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as sharp from "sharp";

export interface QualityAnalysisResult {
  flags: string[];
  brightness?: number;
  fileSize: number;
  duration?: number;
}

async function withTempFile<T>(
  buffer: Buffer,
  ext: string,
  fn: (path: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gis-quality-"));
  const filePath = join(dir, `file${ext}`);
  writeFileSync(filePath, buffer);
  try {
    return await fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function getVideoDuration(filePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    let output = "";
    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });
    ffprobe.stderr.on("data", () => {});
    ffprobe.on("close", () => {
      const duration = parseFloat(output.trim());
      resolve(isNaN(duration) ? undefined : duration);
    });
  });
}

async function extractVideoFrame(filePath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      filePath,
      "-ss",
      "00:00:00.500",
      "-vframes",
      "1",
      "-f",
      "image2pipe",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (data) => chunks.push(data));
    ffmpeg.stderr.on("data", () => {});
    ffmpeg.on("close", () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
  });
}

async function getMeanBrightness(buffer: Buffer): Promise<number | undefined> {
  try {
    const stats = await sharp(buffer).stats();
    const channels = stats.channels;
    if (channels.length === 0) return undefined;
    const mean =
      channels.reduce((sum, ch) => sum + ch.mean, 0) / channels.length;
    return mean;
  } catch {
    return undefined;
  }
}

export async function analyzeFileQuality(
  file: File
): Promise<QualityAnalysisResult> {
  const flags: string[] = [];
  const buffer = Buffer.from(await file.arrayBuffer());
  const fileSize = buffer.length;
  const isVideo = file.type.startsWith("video/");
  let duration: number | undefined;
  let brightness: number | undefined;

  if (isVideo) {
    const ext = file.name.match(/\.[^.]+$/)?.[0] || ".mp4";
    await withTempFile(buffer, ext, async (tempPath) => {
      duration = await getVideoDuration(tempPath);
      const frameBuffer = await extractVideoFrame(tempPath);
      if (frameBuffer) {
        brightness = await getMeanBrightness(frameBuffer);
      }
    });
  } else {
    brightness = await getMeanBrightness(buffer);
  }

  if (duration !== undefined && duration < 1) {
    flags.push("Too short");
  }

  if (brightness !== undefined) {
    if (brightness < 30) flags.push("Very dark");
    if (brightness > 250) flags.push("Very bright/overexposed");
  }

  if (!isVideo && fileSize < 50 * 1024) {
    flags.push("Low resolution");
  }

  return { flags, brightness, fileSize, duration };
}
