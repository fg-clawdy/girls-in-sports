import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { prisma } from "../prisma";
import { downloadAssetToFile, uploadAssetFromFile, addAssetsToAlbum } from "../immich";

const PROXY_OUTPUT_DIR = "/tmp/gis-proxies";
const SAFETY_MARGIN_MS = 200;

interface RenderProxyPayload {
  campaignId: string;
  eventId: string;
}

export async function handleRenderProxy({
  payload,
  jobId,
}: {
  payload: unknown;
  jobId: string;
}) {
  const { campaignId } = payload as RenderProxyPayload;
  console.log(`[render-proxy] Starting job ${jobId} for campaign ${campaignId}`);

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      event: true,
      campaignClips: {
        include: { asset: true },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (!campaign.scriptJson) throw new Error(`Campaign ${campaignId} has no script`);

  const script = campaign.scriptJson as any;
  const clips: Array<{
    assetId: string;
    startTimeMs: number;
    endTimeMs: number;
    durationMs: number;
    narrativeLabel: string;
    textOverlay: string | null;
    order: number;
  }> = script.clips || [];

  if (clips.length === 0) {
    throw new Error("ProductionScript contains no clips");
  }

  const workDir = path.join(PROXY_OUTPUT_DIR, campaignId);
  await fs.mkdir(workDir, { recursive: true });

  try {
    // ── 1. Download and cut each segment ──
    const segmentFiles: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const cc = campaign.campaignClips.find((c) => c.assetId === clip.assetId);
      if (!cc || !cc.asset) throw new Error(`Asset ${clip.assetId} not found in campaign`);

      const asset = cc.asset;
      if (!asset.immichAssetId) {
        throw new Error(`Asset ${asset.id} has no immichAssetId`);
      }

      const maxMs = Math.round((asset.durationSeconds || 0) * 1000);
      const startMs = Math.max(0, clip.startTimeMs);
      const endMs = maxMs > 0
        ? Math.min(clip.endTimeMs, maxMs - SAFETY_MARGIN_MS)
        : clip.endTimeMs;

      if (startMs >= endMs) {
        console.warn(`[render-proxy] Clip ${clip.assetId} has invalid timestamps ${startMs}-${endMs}, skipping`);
        continue;
      }

      const sourcePath = path.join(workDir, `src_${i}_${asset.id}.mp4`);
      await downloadAssetToFile(asset.immichAssetId, sourcePath);

      const segPath = path.join(workDir, `seg_${i}.mp4`);
      await cutSegment(sourcePath, segPath, startMs / 1000, endMs / 1000);

      // ── Label this segment with clip number before concat ──
      const labeledPath = path.join(workDir, `seg_${i}_labeled.mp4`);
      await runFfmpeg([
        "-i", segPath,
        "-vf", `drawtext=text='Clip ${i + 1}':fontcolor=white@0.9:fontsize=28:x=20:y=h-40:box=1:boxcolor=black@0.5:boxborderw=4`,
        "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
        "-c:a", "copy",
        "-y", labeledPath,
      ]);
      segmentFiles.push(labeledPath);

      // Clean up intermediates immediately
      try { await fs.unlink(sourcePath); } catch { /* ignore */ }
      try { await fs.unlink(segPath); } catch { /* ignore */ }
    }

    if (segmentFiles.length === 0) {
      throw new Error("No valid segments after cutting");
    }

    // ── 2. Build concat list ──
    const concatListPath = path.join(workDir, "concat.txt");
    const concatLines = segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`);
    await fs.writeFile(concatListPath, concatLines.join("\n") + "\n");

    // ── 3. Concatenate ──
    const concatPath = path.join(workDir, "concat.mp4");
    await runFfmpeg([
      "-f", "concat", "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-y", concatPath,
    ]);

    // ── 4. Scale + watermark + encode ──
    const proxyPath = path.join(workDir, "proxy.mp4");
    const watermarkText = "DRAFT \\u2013 GIS";
    const vf = [
      `scale=720:1280:force_original_aspect_ratio=decrease`,
      `pad=720:1280:(ow-iw)/2:(oh-ih)/2`,
      `drawtext=text='${watermarkText}':fontcolor=white@0.6:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2`,
    ].join(",");

    await runFfmpeg([
      "-i", concatPath,
      "-vf", vf,
      "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", proxyPath,
    ]);

    // ── 5. Optional music mix ──
    let finalProxyPath = proxyPath;
    const musicUrl = campaign.musicUrl;
    if (musicUrl && !musicUrl.startsWith("failed:")) {
      const musicPath = path.join(workDir, "music.mp3");
      // musicUrl may be local file path or http URL
      if (musicUrl.startsWith("http")) {
        const res = await fetch(musicUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          await fs.writeFile(musicPath, buf);
        }
      } else {
        try {
          await fs.copyFile(musicUrl, musicPath);
        } catch {
          // music file missing — proceed without
        }
      }

      if (await fileExists(musicPath)) {
        const mixedPath = path.join(workDir, "proxy_music.mp4");
        await runFfmpeg([
          "-i", proxyPath,
          "-i", musicPath,
          "-filter_complex",
          "[0:a]volume=1.0[va];[1:a]volume=0.3[ma];[va][ma]amix=inputs=2:duration=first[a]",
          "-map", "0:v",
          "-map", "[a]",
          "-c:v", "copy",
          "-c:a", "aac", "-b:a", "128k",
          "-y", mixedPath,
        ]);
        finalProxyPath = mixedPath;
      }
    }

    // ── 6. Upload to Immich ──
    const fileName = `${campaign.name.replace(/[^a-zA-Z0-9]/g, "_")}_proxy.mp4`;
    const now = new Date().toISOString();
    const immichAssetId = await uploadAssetFromFile(
      finalProxyPath,
      `gis-proxy-${campaignId}`,
      fileName,
      now,
      now,
      "video/mp4"
    );

    // Add to GIS Campaigns album (create if needed)
    let albumId = campaign.event?.immichAlbumId;
    if (albumId) {
      await addAssetsToAlbum(albumId, [immichAssetId]);
    }

    // Create PROXY Asset in GIS DB
    const proxyAsset = await prisma.asset.create({
      data: {
        eventId: campaign.eventId,
        immichAssetId,
        type: "PROXY",
        status: "UPLOADED",
        filePath: finalProxyPath,
      },
    });

    // Update campaign
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        proxyAssetId: proxyAsset.id,
        status: "PROXY_READY",
      },
    });

    console.log(`[render-proxy] Proxy ready for campaign ${campaignId}: ${proxyAsset.id}`);
  } finally {
    // Cleanup work dir
    try {
      const files = await fs.readdir(workDir);
      await Promise.all(files.map((f) => fs.unlink(path.join(workDir, f)).catch(() => {})));
      await fs.rmdir(workDir);
    } catch {
      /* ignore cleanup errors */
    }
  }
}

async function cutSegment(
  sourcePath: string,
  outputPath: string,
  startS: number,
  endS: number
): Promise<void> {
  return runFfmpeg([
    "-ss", startS.toFixed(3),
    "-to", endS.toFixed(3),
    "-i", sourcePath,
    "-c", "copy",
    "-y", outputPath,
  ]);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-800)}`));
      } else {
        resolve();
      }
    });
    proc.on("error", (err) => reject(err));
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
