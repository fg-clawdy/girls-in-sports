// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO SEGMENTATION ENGINE
// Phase 1: ffmpeg scene detection (local, free)
// Phase 2: Dense frame sampling per scene
// Phase 3: Audio analysis mapped to scenes by timestamp
// Phase 4: Multi-segment extraction with variable durations
// ═══════════════════════════════════════════════════════════════════════════════

import { spawn } from "child_process";
import { mkdtemp, readFile, unlink, rmdir } from "fs/promises";
import * as pathModule from "path";
import * as osModule from "os";

const path = pathModule;
const os = osModule;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Scene {
  startTime: number; // seconds
  endTime: number;
  duration: number;
  avgMotion: number; // 0-1, from ffmpeg scene detection
}

export interface FrameScore {
  timestamp: number;
  score: number; // 0-100 from vision model
  reasons: string[];
}

export interface AudioSegment {
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

export interface SceneScore {
  sceneIndex: number;
  visionScore: number; // averaged frame scores within scene
  audioScore: number;
  motionScore: number; // from scene detection
  combinedScore: number;
  frameCount: number;
  keywordHits: string[];
  topReasons: string[];
}

export interface ProductionSegment {
  assetId: string;
  startTime: number; // within the video
  endTime: number;
  duration: number;
  estimatedType: "action" | "speech" | "mixed" | "montage";
  score: number;
  reasons: string[];
}

// ─── Phase 1: ffmpeg Scene Detection ──────────────────────────────────────────

/**
 * Detect scenes in a video using ffmpeg's select filter.
 * Returns an array of scene boundaries with motion intensity.
 *
 * Threshold: scene change detected when difference between frames > threshold
 * Lower threshold = more scenes detected
 */
export async function detectScenes(
  videoPath: string,
  threshold: number = 0.3
): Promise<Scene[]> {
  return new Promise((resolve, reject) => {
    const scenes: Scene[] = [];
    let lastSceneEnd = 0;
    let lastPts = 0;

    const ffmpeg = spawn("ffmpeg", [
      "-i", videoPath,
      "-filter:v", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ]);

    let stderrBuffer = "";

    ffmpeg.stderr.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    ffmpeg.on("close", (code: number | null) => {
      if (code !== 0 && code !== 255) {
        // ffmpeg often exits 255 with filters, that's ok
        reject(new Error(`ffmpeg scene detection failed: code ${code}`));
        return;
      }

      // Parse scene change timestamps from stderr
      // Format: "pts_time:1.234" or "pts: 12345 pts_time:1.234"
      const ptsMatches = stderrBuffer.matchAll(/pts_time:\s*([\d.]+)/g);
      const timestamps: number[] = [];
      for (const match of Array.from(ptsMatches)) {
        const t = parseFloat(match[1]);
        if (!isNaN(t) && t > 0) timestamps.push(t);
      }

      // Also look for "scene:" values to get motion intensity
      const sceneMatches = stderrBuffer.matchAll(/scene:\s*([\d.]+)/g);
      const motions: number[] = [];
      for (const match of Array.from(sceneMatches)) {
        const m = parseFloat(match[1]);
        if (!isNaN(m)) motions.push(m);
      }

      // Build scene list
      let currentStart = 0;
      for (let i = 0; i < timestamps.length; i++) {
        const endTime = timestamps[i];
        const motion = motions[i] || threshold;
        scenes.push({
          startTime: currentStart,
          endTime: endTime,
          duration: endTime - currentStart,
          avgMotion: Math.min(motion, 1.0),
        });
        currentStart = endTime;
      }

      // Add final scene (from last cut to end)
      // We need total duration — let's get it
      getVideoDuration(videoPath)
        .then((totalDuration) => {
          if (currentStart < totalDuration) {
            scenes.push({
              startTime: currentStart,
              endTime: totalDuration,
              duration: totalDuration - currentStart,
              avgMotion: threshold * 0.5, // assume lower motion for final scene
            });
          }

          // If no scenes detected, treat entire video as one scene
          if (scenes.length === 0) {
            scenes.push({
              startTime: 0,
              endTime: totalDuration,
              duration: totalDuration,
              avgMotion: 0.2,
            });
          }

          resolve(scenes);
        })
        .catch(reject);
    });

    ffmpeg.on("error", reject);
  });
}

async function getVideoDuration(videoPath: string): Promise<number> {
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
      resolve(isNaN(duration) ? 30 : duration); // fallback 30s
    });

    ffprobe.on("error", () => resolve(30));
  });
}

// ─── Phase 2: Dense Frame Sampling per Scene ──────────────────────────────────

/**
 * Calculate how many frames to extract from each scene.
 * Short scenes get fewer frames, long scenes get more.
 * Target: roughly 1 frame per 1-2 seconds within each scene.
 */
export function calculateSceneFrameCounts(
  scenes: Scene[],
  minFramesPerScene: number = 2,
  maxFramesPerScene: number = 12,
  targetSecondsPerFrame: number = 1.5
): Map<number, number> {
  const counts = new Map<number, number>();

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const rawCount = Math.round(scene.duration / targetSecondsPerFrame);
    const clamped = Math.max(minFramesPerScene, Math.min(maxFramesPerScene, rawCount));
    counts.set(i, clamped);
  }

  return counts;
}

/**
 * Extract specific frame timestamps from a video using ffmpeg.
 * Returns an array of { timestamp, imagePath } for each frame.
 */
export async function extractFramesAtTimestamps(
  videoPath: string,
  timestamps: number[],
  assetId: string
): Promise<Array<{ timestamp: number; imagePath: string }>> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `gis-frames-${assetId}-`));
  const frames: Array<{ timestamp: number; imagePath: string }> = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const outPath = path.join(tmpDir, `frame_${i}_${ts.toFixed(2)}.jpg`);

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-ss", ts.toFixed(3),
        "-i", videoPath,
        "-vframes", "1",
        "-q:v", "2", // high quality
        "-y",
        outPath,
      ]);

      ffmpeg.on("close", (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg frame extraction failed at ${ts}s`));
      });

      ffmpeg.on("error", reject);
    });

    frames.push({ timestamp: ts, imagePath: outPath });
  }

  return frames;
}

// ─── Phase 3: Audio Mapping to Scenes ─────────────────────────────────────────

/**
 * Map STT audio segments to scenes based on timestamp overlap.
 * Returns per-scene audio analysis.
 */
export function mapAudioToScenes(
  scenes: Scene[],
  audioSegments: AudioSegment[]
): Map<number, { segments: AudioSegment[]; keywordHits: string[]; avgConfidence: number }> {
  const result = new Map<number, { segments: AudioSegment[]; keywordHits: string[]; avgConfidence: number }>();

  for (let i = 0; i < scenes.length; i++) {
    result.set(i, { segments: [], keywordHits: [], avgConfidence: 0 });
  }

  // Positive keywords that indicate marketable moments
  const POSITIVE_KEYWORDS = [
    "goal", "score", "yes", "yeah", "go", "nice", "great", "awesome", "perfect",
    "hustle", "dig", "push", "drive", "attack", "fire", "let's go",
    "good job", "well done", "excellent", "amazing", "incredible",
    "cheer", "cheering", "applause", "clapping",
    "shoot", "shot", "pass", "dribble", "catch", "throw", "swing", "kick",
    "run", "sprint", "block", "tackle", "save",
    "coach", "instruction", "drill", "practice", "training",
  ];

  for (const segment of audioSegments) {
    // Find which scene(s) this segment overlaps with
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const overlap =
        segment.start < scene.endTime && segment.end > scene.startTime;

      if (overlap) {
        const sceneData = result.get(i)!;
        sceneData.segments.push(segment);

        // Check for keywords
        const lowerText = segment.text.toLowerCase();
        for (const kw of POSITIVE_KEYWORDS) {
          const regex = new RegExp(`\\b${kw}\\b`, "gi");
          if (regex.test(lowerText)) {
            sceneData.keywordHits.push(kw);
          }
        }

        if (segment.confidence) {
          const totalConf = sceneData.avgConfidence * sceneData.segments.length + segment.confidence;
          sceneData.avgConfidence = totalConf / sceneData.segments.length;
        }
      }
    }
  }

  return result;
}

/**
 * Compute audio score for a scene (0-100).
 */
export function computeSceneAudioScore(
  sceneAudio: { segments: AudioSegment[]; keywordHits: string[]; avgConfidence: number },
  sceneDuration: number
): { score: number; keywordCount: number } {
  const { segments, keywordHits, avgConfidence } = sceneAudio;

  // Speech density: what fraction of the scene has spoken content?
  const speechDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const speechDensity = Math.min(speechDuration / Math.max(sceneDuration, 1), 1);

  // Keyword richness
  const keywordScore = Math.min(keywordHits.length * 10, 50); // cap at 50

  // Density bonus
  const densityBonus = speechDensity * 30; // 0-30

  // Confidence bonus (if available)
  const confidenceBonus = avgConfidence > 0 ? avgConfidence * 10 : 0;

  const score = Math.min(100, keywordScore + densityBonus + confidenceBonus);

  return {
    score: Math.round(score),
    keywordCount: keywordHits.length,
  };
}

// ─── Phase 4: Segment Extraction & Classification ─────────────────────────────

/**
 * Classify what type of content a scene likely contains based on signals.
 */
export function classifySceneType(
  scene: Scene,
  visionScore: number,
  audioScore: number,
  motionScore: number
): "action" | "speech" | "mixed" | "montage" {
  const hasHighMotion = motionScore > 0.5;
  const hasHighAudio = audioScore > 40;
  const hasHighVision = visionScore > 70;
  const isShort = scene.duration < 5;
  const isLong = scene.duration > 15;

  // Action: high motion, short, visual quality good
  if (hasHighMotion && isShort && hasHighVision) return "action";

  // Speech: high audio, longer duration, lower motion
  if (hasHighAudio && isLong && !hasHighMotion) return "speech";

  // Mixed: both motion and audio
  if (hasHighMotion && hasHighAudio) return "mixed";

  // Montage: good visuals, moderate everything
  if (hasHighVision && !isLong) return "montage";

  // Default based on strongest signal
  if (audioScore > visionScore && audioScore > motionScore * 100) return "speech";
  if (motionScore > 0.3) return "action";
  return "montage";
}

/**
 * Determine target duration for a segment based on its type and score.
 */
export function getSegmentDuration(
  type: "action" | "speech" | "mixed" | "montage",
  sceneDuration: number,
  score: number
): { minDuration: number; targetDuration: number; maxDuration: number } {
  const baseDurations: Record<string, { min: number; target: number; max: number }> = {
    action: { min: 1.5, target: 3, max: 6 },
    speech: { min: 5, target: 12, max: 25 },
    mixed: { min: 3, target: 6, max: 12 },
    montage: { min: 2, target: 4, max: 8 },
  };

  const base = baseDurations[type];

  // High-scoring segments can be longer
  const scoreMultiplier = score > 80 ? 1.3 : score > 60 ? 1.0 : 0.7;

  return {
    minDuration: Math.min(base.min, sceneDuration),
    targetDuration: Math.min(base.target * scoreMultiplier, sceneDuration),
    maxDuration: Math.min(base.max * scoreMultiplier, sceneDuration),
  };
}

/**
 * Build production segments from scored scenes.
 * Can produce MULTIPLE segments from a single video.
 * Adjacent high-scoring scenes may be merged into longer segments.
 */
export function buildProductionSegments(
  assetId: string,
  scenes: Scene[],
  sceneScores: SceneScore[],
  scoreThreshold: number = 55 // scenes below this are dropped
): ProductionSegment[] {
  const segments: ProductionSegment[] = [];

  // Filter to scenes that meet threshold
  const goodScenes = sceneScores
    .filter((s) => s.combinedScore >= scoreThreshold)
    .sort((a, b) => a.sceneIndex - b.sceneIndex);

  if (goodScenes.length === 0) return segments;

  // Group adjacent good scenes into clusters
  const clusters: SceneScore[][] = [];
  let currentCluster: SceneScore[] = [goodScenes[0]];

  for (let i = 1; i < goodScenes.length; i++) {
    const prev = goodScenes[i - 1];
    const curr = goodScenes[i];

    // If scenes are adjacent (or nearly so), merge them
    const prevScene = scenes[prev.sceneIndex];
    const currScene = scenes[curr.sceneIndex];
    const gap = currScene.startTime - prevScene.endTime;

    if (gap < 2) {
      // Less than 2s gap — merge into same cluster
      currentCluster.push(curr);
    } else {
      // Start new cluster
      clusters.push(currentCluster);
      currentCluster = [curr];
    }
  }
  clusters.push(currentCluster);

  // Build production segments from clusters
  for (const cluster of clusters) {
    const firstScene = scenes[cluster[0].sceneIndex];
    const lastScene = scenes[cluster[cluster.length - 1].sceneIndex];

    const startTime = firstScene.startTime;
    const endTime = lastScene.endTime;
    const duration = endTime - startTime;

    // Compute blended type and score
    const avgMotion = cluster.reduce((sum, s) => sum + s.motionScore, 0) / cluster.length;
    const avgVision = cluster.reduce((sum, s) => sum + s.visionScore, 0) / cluster.length;
    const avgAudio = cluster.reduce((sum, s) => sum + s.audioScore, 0) / cluster.length;
    const combinedScore = cluster.reduce((sum, s) => sum + s.combinedScore, 0) / cluster.length;

    const type = classifySceneType(
      { startTime, endTime, duration, avgMotion },
      avgVision,
      avgAudio,
      avgMotion
    );

    const durationConfig = getSegmentDuration(type, duration, combinedScore);

    // If cluster is longer than max duration, find the best sub-window
    let finalStart = startTime;
    let finalEnd = endTime;

    if (duration > durationConfig.maxDuration) {
      // Find the highest-scoring sub-window within this cluster
      const bestScene = cluster.reduce((best, curr) =>
        curr.combinedScore > best.combinedScore ? curr : best
      );
      const bestSceneObj = scenes[bestScene.sceneIndex];
      const windowHalf = durationConfig.targetDuration / 2;

      finalStart = Math.max(bestSceneObj.startTime, bestSceneObj.startTime + bestSceneObj.duration / 2 - windowHalf);
      finalEnd = Math.min(bestSceneObj.endTime, finalStart + durationConfig.targetDuration);
    }

    // Collect all reasons from cluster
    const allReasons = cluster.flatMap((s) => s.topReasons);
    const uniqueReasons = Array.from(new Set(allReasons)).slice(0, 4);

    segments.push({
      assetId,
      startTime: finalStart,
      endTime: finalEnd,
      duration: finalEnd - finalStart,
      estimatedType: type,
      score: Math.round(combinedScore),
      reasons: uniqueReasons,
    });
  }

  return segments.sort((a, b) => b.score - a.score);
}

// ─── Phase 5: Full Pipeline ───────────────────────────────────────────────────

export interface SegmentationResult {
  assetId: string;
  scenes: Scene[];
  sceneScores: SceneScore[];
  segments: ProductionSegment[];
  totalFramesAnalyzed: number;
  audioSegmentCount: number;
}

/**
 * Full segmentation pipeline for a single video.
 *
 * Usage:
 *   const result = await segmentVideo(localPath, assetId, audioSegments);
 *   result.segments // Array of production-ready clips
 */
export async function segmentVideo(
  videoPath: string,
  assetId: string,
  audioSegments: AudioSegment[],
  sceneThreshold: number = 0.3
): Promise<SegmentationResult> {
  // Step 1: Detect scenes
  const scenes = await detectScenes(videoPath, sceneThreshold);

  // Step 2: Calculate frame counts per scene
  const frameCounts = calculateSceneFrameCounts(scenes);

  // Step 3: Extract frames at calculated positions per scene
  const allFrameTimestamps: number[] = [];
  const sceneFrameMap = new Map<number, number[]>(); // sceneIndex -> timestamps

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const count = frameCounts.get(i) || 3;
    const timestamps: number[] = [];

    for (let f = 0; f < count; f++) {
      const t = scene.startTime + (scene.duration * (f + 1)) / (count + 1);
      timestamps.push(t);
      allFrameTimestamps.push(t);
    }

    sceneFrameMap.set(i, timestamps);
  }

  // Extract all frames (this will be used by vision analysis)
  const extractedFrames = await extractFramesAtTimestamps(
    videoPath,
    allFrameTimestamps,
    assetId
  );

  // Step 4: Map audio to scenes
  const audioByScene = mapAudioToScenes(scenes, audioSegments);

  // Step 5: Build scene scores (vision scores will be injected after analysis)
  const sceneScores: SceneScore[] = scenes.map((scene, i) => {
    const sceneAudio = audioByScene.get(i) || { segments: [], keywordHits: [], avgConfidence: 0 };
    const { score: audioScore, keywordCount } = computeSceneAudioScore(sceneAudio, scene.duration);

    return {
      sceneIndex: i,
      visionScore: 0, // filled in after vision analysis
      audioScore,
      motionScore: scene.avgMotion,
      combinedScore: audioScore * 0.3 + scene.avgMotion * 50, // temporary, vision added later
      frameCount: frameCounts.get(i) || 0,
      keywordHits: sceneAudio.keywordHits,
      topReasons: [], // filled in after vision analysis
    };
  });

  // Return with extracted frame paths so caller can run vision analysis
  // The caller will update visionScore and combinedScore, then call buildProductionSegments
  return {
    assetId,
    scenes,
    sceneScores,
    segments: [], // populated after vision scores are injected
    totalFramesAnalyzed: extractedFrames.length,
    audioSegmentCount: audioSegments.length,
  };
}

/**
 * After vision analysis, inject frame scores into scene scores and build final segments.
 */
export function finalizeSegments(
  assetId: string,
  scenes: Scene[],
  sceneScores: SceneScore[],
  frameScores: Array<{ timestamp: number; score: number; reasons: string[] }>,
  sceneFrameMap: Map<number, number[]>
): ProductionSegment[] {
  // Inject vision scores per scene
  for (let i = 0; i < scenes.length; i++) {
    const timestamps = sceneFrameMap.get(i) || [];
    const frameData = frameScores.filter((f) =>
      timestamps.some((t) => Math.abs(f.timestamp - t) < 0.5)
    );

    if (frameData.length > 0) {
      const avgVision = frameData.reduce((sum, f) => sum + f.score, 0) / frameData.length;
      const allReasons = frameData.flatMap((f) => f.reasons);
      const topReasons = Array.from(new Set(allReasons)).slice(0, 3);

      sceneScores[i].visionScore = Math.round(avgVision);
      sceneScores[i].topReasons = topReasons;

      // Recalculate combined score: 50% vision, 30% audio, 20% motion
      sceneScores[i].combinedScore = Math.round(
        sceneScores[i].visionScore * 0.5 +
        sceneScores[i].audioScore * 0.3 +
        sceneScores[i].motionScore * 20
      );
    }
  }

  return buildProductionSegments(assetId, scenes, sceneScores);
}
