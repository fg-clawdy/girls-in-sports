import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";

const OUTPUT_DIR = process.env.COMPOSITION_OUTPUT_DIR || "/tmp/gis-compositions";

function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { musicFilePath } = body;

    if (!musicFilePath) {
      return NextResponse.json(
        { error: "musicFilePath is required" },
        { status: 400 }
      );
    }

    // Verify music file exists
    try {
      await fs.access(musicFilePath);
    } catch {
      return NextResponse.json(
        { error: "Music file not found" },
        { status: 404 }
      );
    }

    // The video is at /tmp/gis-compositions/{id}/video.mp4
    const workDir = path.join(OUTPUT_DIR, params.id);
    const videoPath = path.join(workDir, "video.mp4");

    try {
      await fs.access(videoPath);
    } catch {
      return NextResponse.json(
        { error: "Video file not found" },
        { status: 404 }
      );
    }

    // Get video duration
    const probe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);

    let durationStr = "";
    probe.stdout.on("data", (d) => (durationStr += d));
    const duration = await new Promise<number>((resolve, reject) => {
      probe.on("close", (code) => {
        if (code === 0) resolve(parseFloat(durationStr.trim()) || 60);
        else reject(new Error("ffprobe failed"));
      });
    });

    // Mix music into video — loop/trim to match, lower volume, fade in/out
    const outputPath = path.join(workDir, "video_with_music.mp4");
    const musicArgs = [
      "-i", videoPath,
      "-i", musicFilePath,
      "-filter_complex",
      `[1:a]aloop=loop=-1:size=2e+09,atrim=start=0:end=${duration},afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(0, duration - 3)}:d=3,volume=0.25[a]`,
      "-map", "0:v",
      "-map", "[a]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outputPath,
    ];

    await runFFmpeg(musicArgs);

    // Replace original video with the music version
    await fs.rename(outputPath, videoPath);

    // Clean up music file if desired
    // await fs.unlink(musicFilePath).catch(() => {});

    return NextResponse.json({
      success: true,
      message: "Background music mixed into video successfully",
    });
  } catch (error) {
    console.error("Mix music error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to mix music" },
      { status: 500 }
    );
  }
}
