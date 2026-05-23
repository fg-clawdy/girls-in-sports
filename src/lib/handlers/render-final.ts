import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { prisma } from "../prisma";
import { downloadAssetToFile, uploadAssetFromFile, addAssetsToAlbum, updateAssetDescription } from "../immich";
import { getBeatAlignedDuration, snapToNearestBeat } from "../beat-sync-service";
import { resolveSceneCut } from "../resolve-scene-cut";

const FINAL_OUTPUT_DIR = "/outputs";
const SAFETY_MARGIN_MS = 150;

interface RenderFinalPayload {
  campaignId: string;
  eventId: string;
}

export async function handleRenderFinal({
  payload,
  jobId,
}: {
  payload: unknown;
  jobId: string;
}) {
  const { campaignId } = payload as RenderFinalPayload;
  console.log(`[render-final] Starting job ${jobId} for campaign ${campaignId}`);

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      event: true,
      campaignClips: {
        include: { asset: { include: { parentAsset: true } } },
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

  if (clips.length === 0) throw new Error("ProductionScript contains no clips");

  const workDir = path.join("/tmp", "gis-final", campaignId);
  const outDir = path.join(FINAL_OUTPUT_DIR, campaignId);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  try {
    // ── 1. No AI upscale (US-011/US-016 decision: Venice /video/enhance has no working production path)
    // All sources are used at native resolution. Low-res clips (<720px vertical) are rendered as-is
    // with a visible warning badge in the UI. Effective output resolution is noted in final metadata.
    const upscaleMap: Record<string, string> = {};

    // ── 2. Download and cut each segment (scene-aware for child CLIP assets) ──
    const segmentFiles: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const cc = campaign.campaignClips.find((c) => c.assetId === clip.assetId);
      if (!cc || !cc.asset) throw new Error(`Asset ${clip.assetId} not found`);

      const asset = cc.asset;
      if (!asset.immichAssetId) {
        throw new Error(`Asset ${asset.id} has no immichAssetId`);
      }

      // Resolve correct source (parent for legacy virtual scenes) + absolute cut times
      const parentRef = asset.parentAsset
        ? { id: asset.parentAsset.id, immichAssetId: asset.parentAsset.immichAssetId! }
        : null;
      const resolved = resolveSceneCut({
        asset: {
          id: asset.id,
          parentAssetId: asset.parentAssetId,
          immichAssetId: asset.immichAssetId,
          startTimeMs: asset.startTimeMs,
          endTimeMs: asset.endTimeMs,
          durationSeconds: asset.durationSeconds,
        },
        parentAsset: parentRef,
        scriptStartMs: clip.startTimeMs,
        scriptEndMs: clip.endTimeMs,
      });

      const sourceImmichId = resolved.downloadImmichId;
      let cutStartMs = resolved.cutStartMs;
      let cutEndMs = resolved.cutEndMs;

      // Safety margin + clamp against the actual source duration we will download
      const sourceDurMs = asset.parentAsset?.durationSeconds
        ? Math.round(asset.parentAsset.durationSeconds * 1000)
        : Math.round((asset.durationSeconds || 0) * 1000);

      cutStartMs = Math.max(0, cutStartMs);
      cutEndMs = sourceDurMs > 0
        ? Math.min(cutEndMs, sourceDurMs - SAFETY_MARGIN_MS)
        : cutEndMs;

      // US-012: beat-sync adjustment using existing helpers (when music beat data present)
      const beatData = (campaign as any).beatTimestampsJson as any;
      const beats: number[] = Array.isArray(beatData?.beatTimestamps) ? beatData.beatTimestamps : [];
      if (beats.length > 0) {
        const intendedDurS = (cutEndMs - cutStartMs) / 1000;
        const maxDurS = sourceDurMs > 0
          ? Math.min(intendedDurS * 1.3, (sourceDurMs - SAFETY_MARGIN_MS - cutStartMs) / 1000)
          : intendedDurS * 1.3;
        if (maxDurS > 0.1) {
          const alignedDurS = getBeatAlignedDuration(intendedDurS, beats, maxDurS);
          const newEndMs = cutStartMs + Math.round(alignedDurS * 1000);
          if (newEndMs > cutStartMs + 100) {
            cutEndMs = Math.min(cutEndMs, newEndMs);
          }
        }
      }

      if (cutStartMs >= cutEndMs) {
        console.warn(`[render-final] Clip ${clip.assetId} invalid timestamps ${cutStartMs}-${cutEndMs}, skipping`);
        continue;
      }

      const sourcePath = upscaleMap[asset.id]
        ? upscaleMap[asset.id]
        : path.join(workDir, `src_${i}_${asset.id}.mp4`);

      if (!upscaleMap[asset.id]) {
        await downloadAssetToFile(sourceImmichId, sourcePath);
      }

      const segPath = path.join(workDir, `seg_${i}.mp4`);
      await cutSegment(sourcePath, segPath, cutStartMs / 1000, cutEndMs / 1000);
      segmentFiles.push(segPath);

      if (!upscaleMap[asset.id]) {
        try { await fs.unlink(sourcePath); } catch { /* ignore */ }
      }
    }

    if (segmentFiles.length === 0) throw new Error("No valid segments after cutting");

    // ── 3. Concatenate ──
    const concatListPath = path.join(workDir, "concat.txt");
    const concatLines = segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`);
    await fs.writeFile(concatListPath, concatLines.join("\n") + "\n");

    const concatPath = path.join(workDir, "concat.mp4");
    await runFfmpeg([
      "-f", "concat", "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-y", concatPath,
    ]);

    // ── 4. Build scale + text overlay filtergraph ──
    const finalPath = path.join(outDir, "final.mp4");

    // Collect text overlay drawtext filters per segment
    let drawtextFilters: string[] = [];
    clips.forEach((clip, idx) => {
      if (clip.textOverlay && segmentFiles[idx]) {
        // Simple: overlay text at bottom-center for the whole segment duration
        // ffmpeg drawtext with enable expression based on concat segment index is complex;
        // Simpler: apply per-segment before concat, but concat with copy doesn't allow filters.
        // Workaround: do a second pass with overlay after concat.
        // For now, we add a second-pass filter using enable='between(t,start,end)'
      }
    });

    // Because concat with stream copy doesn't allow per-segment filters,
    // we do the text overlays in the final encode pass using enable between times.
    // We need to compute cumulative start/end times for each clip.
    let cumulativeS = 0;
    const textOverlays: Array<{ text: string; startS: number; endS: number }> = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const durS = (clip.endTimeMs - clip.startTimeMs) / 1000;
      if (clip.textOverlay) {
        textOverlays.push({
          text: clip.textOverlay,
          startS: cumulativeS,
          endS: cumulativeS + durS,
        });
      }
      cumulativeS += durS;
    }

    // Build composite drawtext filter chain
    const drawtextParts: string[] = [];
    textOverlays.forEach((to, idx) => {
      const escaped = to.text.replace(/'/g, "\\'")?.replace(/:/g, "\\:") ?? "";
      const fontSize = 48; // proportional to 1080p vertical
      drawtextParts.push(
        `drawtext=text='${escaped}':fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=h*0.85:enable='between(t\\,${to.startS.toFixed(2)}\\,${to.endS.toFixed(2)})':box=1:boxcolor=black@0.5:boxborderw=4`
      );
    });

    const scaleFilter = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";
    const vf = drawtextParts.length > 0
      ? `${scaleFilter},${drawtextParts.join(",")}`
      : scaleFilter;

    // ── 5. Final encode with optional music + loudnorm ──
    const musicUrl = campaign.musicUrl;
    let hasMusic = musicUrl && !musicUrl.startsWith("failed:");

    if (hasMusic && musicUrl) {
      const musicPath = path.join(workDir, "music.mp3");
      if (musicUrl.startsWith("http")) {
        const res = await fetch(musicUrl);
        if (res.ok) {
          await fs.writeFile(musicPath, Buffer.from(await res.arrayBuffer()));
        }
      } else {
        try { await fs.copyFile(musicUrl, musicPath); } catch { /* ignore */ }
      }

      if (await fileExists(musicPath)) {
        // Mixed encode: video + original audio duck + music + loudnorm
        await runFfmpeg([
          "-i", concatPath,
          "-i", musicPath,
          "-filter_complex",
          "[0:a]volume=-12dB[oa];[1:a]volume=0dB[ma];[oa][ma]amix=inputs=2:duration=first[amixed];[amixed]loudnorm=I=-14:TP=-1.5:LRA=11[afinal]",
          "-map", "0:v",
          "-map", "[afinal]",
          "-vf", vf,
          "-c:v", "libx264", "-crf", "18", "-preset", "slow",
          "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart",
          "-y", finalPath,
        ]);
      } else {
        hasMusic = false;
      }
    }

    if (!hasMusic) {
      // Video only (no music)
      await runFfmpeg([
        "-i", concatPath,
        "-vf", vf,
        "-c:v", "libx264", "-crf", "18", "-preset", "slow",
        "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-y", finalPath,
      ]);
    }

    // ── 6. Validate output is h264 ──
    const probe = await probeCodec(finalPath);
    if (probe !== "h264") {
      console.warn(`[render-final] Output codec is ${probe}, expected h264`);
    }

    // ── 7. Upload to Immich ──
    const fileName = `${campaign.name.replace(/[^a-zA-Z0-9]/g, "_")}_final.mp4`;
    const now = new Date().toISOString();
    const immichAssetId = await uploadAssetFromFile(
      finalPath,
      `gis-final-${campaignId}`,
      fileName,
      now,
      now,
      "video/mp4"
    );

    // Add to GIS Campaigns album if event has one
    if (campaign.event?.immichAlbumId) {
      await addAssetsToAlbum(campaign.event.immichAlbumId, [immichAssetId]);
    }

    // Create FINAL Asset in GIS DB
    const finalAsset = await prisma.asset.create({
      data: {
        eventId: campaign.eventId,
        immichAssetId,
        type: "FINAL",
        status: "UPLOADED",
        filePath: finalPath,
      },
    });

    // Record effective resolution + no-AI-upscale decision (US-011/US-016)
    const lowRes = campaign.campaignClips.filter((cc: any) => (cc.asset?.heightPx ?? 9999) < 720);
    const note = [
      "GIS 1080x1920 final (no AI upscale applied — US-016 spike: Venice /video/enhance has no working production path)",
      lowRes.length > 0 ? `Low-res sources (<720p vertical): ${lowRes.map((c: any) => c.assetId).join(", ")}` : "All sources >=720p vertical",
    ].join("\n");
    await updateAssetDescription(immichAssetId, note);

    // Update campaign
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        finalAssetId: finalAsset.id,
        status: "DONE",
      },
    });

    console.log(`[render-final] Final render complete for campaign ${campaignId}: ${finalAsset.id}`);
  } finally {
    // Cleanup work dir (keep outDir for download)
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
  const RENDER_TIMEOUT_MS = 1_200_000; // 20 minutes for final renders (slower preset, higher quality)

  return new Promise((resolve, reject) => {
    const proc = spawn("nice", ["-n", "10", "ffmpeg", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`ffmpeg timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-800)}`));
      } else {
        resolve();
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function probeCodec(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("nice", ["-n", "10", "ffprobe", ...[
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]]);
    let out = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.on("close", () => resolve(out.trim() || "unknown"));
    proc.on("error", () => resolve("unknown"));
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
