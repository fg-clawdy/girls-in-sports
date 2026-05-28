// ═══════════════════════════════════════════════════════════════════════════════
// CANDIDATE WINDOW IDENTIFICATION (US-009)
// Merges motion density + audio energy into ranked candidate time windows
// for AI-first segmentation. Only promising windows are sent to Vision API.
// ═══════════════════════════════════════════════════════════════════════════════

import { AudioEnergyProfile } from "./ffmpeg-utils";
import { Scene } from "./video-segmentation";

export interface CandidateWindow {
  startTime: number;   // seconds
  endTime: number;
  motionScore: number; // 0-100
  audioScore: number;  // 0-100
  combinedScore: number; // weighted 0.4 motion + 0.6 audio
}

interface MotionDensityResult {
  scenes: Scene[];
  sceneChangesPerSecond: number; // overall motion density
}

/**
 * Identify candidate time windows by merging motion density and audio energy.
 *
 * @param motionProfile — scenes from detectScenes with motion intensity
 * @param audioProfile — audio energy profile from computeAudioEnergyProfile
 * @param duration — total video duration in seconds
 * @returns ranked candidate windows (max 30), sorted by combinedScore descending
 */
export function identifyCandidateWindows(
  motionProfile: MotionDensityResult,
  audioProfile: AudioEnergyProfile,
  duration: number
): CandidateWindow[] {
  if (duration <= 0) return [];

  // ── 1. Build 1-second buckets for motion density ──
  const motionBuckets = new Float64Array(Math.ceil(duration));
  motionBuckets.fill(0);

  for (const scene of motionProfile.scenes) {
    const startIdx = Math.max(0, Math.floor(scene.startTime));
    const endIdx = Math.min(motionBuckets.length, Math.ceil(scene.endTime));
    for (let i = startIdx; i < endIdx; i++) {
      motionBuckets[i] += scene.avgMotion;
    }
  }

  // Normalize motion scores 0-100
  const maxMotion = maxInArray(motionBuckets) || 1;
  for (let i = 0; i < motionBuckets.length; i++) {
    motionBuckets[i] = (motionBuckets[i] / maxMotion) * 100;
  }

  // ── 2. Build 1-second buckets for audio energy ──
  const audioBuckets = new Float64Array(Math.ceil(duration));
  audioBuckets.fill(0);

  for (const seg of audioProfile.segments) {
    const startIdx = Math.max(0, Math.floor(seg.startTime));
    const endIdx = Math.min(audioBuckets.length, Math.ceil(seg.endTime));
    for (let i = startIdx; i < endIdx; i++) {
      // Map dB to 0-100 (assume -91 dB = silence, -20 dB = very loud)
      const normalizedDb = Math.max(0, Math.min(100, (seg.meanDb + 91) / 71 * 100));
      audioBuckets[i] = normalizedDb;
    }
  }

  // ── 3. Generate initial windows from motion peaks ──
  const rawWindows: CandidateWindow[] = [];
  let windowStart = 0;

  for (let i = 1; i < motionBuckets.length; i++) {
    const prev = motionBuckets[i - 1];
    const curr = motionBuckets[i];

    // End window when motion drops significantly
    if (curr < prev * 0.3 && i - windowStart >= 2) {
      const motionAvg = avg(motionBuckets, windowStart, i);
      const audioAvg = avg(audioBuckets, windowStart, i);
      rawWindows.push(makeWindow(windowStart, i, motionAvg, audioAvg));
      windowStart = i;
    }
  }

  // Close final window
  if (windowStart < motionBuckets.length) {
    const motionAvg = avg(motionBuckets, windowStart, motionBuckets.length);
    const audioAvg = avg(audioBuckets, windowStart, motionBuckets.length);
    rawWindows.push(makeWindow(windowStart, motionBuckets.length, motionAvg, audioAvg));
  }

  // If no motion peaks, create uniform windows every 5s
  if (rawWindows.length === 0) {
    const step = 5;
    for (let t = 0; t < duration; t += step) {
      const end = Math.min(t + step, duration);
      const motionAvg = avg(motionBuckets, t, end);
      const audioAvg = avg(audioBuckets, t, end);
      rawWindows.push(makeWindow(t, end, motionAvg, audioAvg));
    }
  }

  // ── 4. Merge short windows (< 2s) ──
  let merged: CandidateWindow[] = [];
  for (const w of rawWindows) {
    const dur = w.endTime - w.startTime;
    if (dur < 2 && merged.length > 0) {
      const last = merged[merged.length - 1];
      last.endTime = w.endTime;
      last.motionScore = (last.motionScore + w.motionScore) / 2;
      last.audioScore = (last.audioScore + w.audioScore) / 2;
      last.combinedScore = last.motionScore * 0.4 + last.audioScore * 0.6;
    } else {
      merged.push({ ...w });
    }
  }

  // ── 5. Split long windows (> 30s) at lowest-confidence point ──
  let split: CandidateWindow[] = [];
  for (const w of merged) {
    const dur = w.endTime - w.startTime;
    if (dur > 30) {
      const mid = w.startTime + dur / 2;
      // Find the lowest combined score point to split at
      let bestSplit = mid;
      let lowestScore = Infinity;
      for (let s = Math.floor(w.startTime) + 5; s < Math.floor(w.endTime) - 5; s++) {
        const score = motionBuckets[s] * 0.4 + audioBuckets[s] * 0.6;
        if (score < lowestScore) {
          lowestScore = score;
          bestSplit = s;
        }
      }
      split.push(
        makeWindow(w.startTime, bestSplit, avg(motionBuckets, w.startTime, bestSplit), avg(audioBuckets, w.startTime, bestSplit)),
        makeWindow(bestSplit, w.endTime, avg(motionBuckets, bestSplit, w.endTime), avg(audioBuckets, bestSplit, w.endTime))
      );
    } else {
      split.push(w);
    }
  }

  // ── 6. Rank by combinedScore descending, cap at 30 ──
  split.sort((a, b) => b.combinedScore - a.combinedScore);
  return split.slice(0, 30);
}

// ── Helpers ──

function avg(arr: Float64Array, start: number, end: number): number {
  let sum = 0;
  const lo = Math.max(0, Math.floor(start));
  const hi = Math.min(arr.length, Math.ceil(end));
  if (hi <= lo) return 0;
  for (let i = lo; i < hi; i++) sum += arr[i];
  return sum / (hi - lo);
}

function makeWindow(start: number, end: number, motion: number, audio: number): CandidateWindow {
  return {
    startTime: Math.max(0, start),
    endTime: end,
    motionScore: Math.round(motion),
    audioScore: Math.round(audio),
    combinedScore: Math.round(motion * 0.4 + audio * 0.6),
  };
}

function maxInArray(arr: Float64Array): number {
  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  return max;
}

/**
 * Build a MotionDensityResult from ffmpeg scene detection output.
 * Used by analyzeAndSegment before calling identifyCandidateWindows.
 */
export function buildMotionDensityProfile(scenes: Scene[], duration: number): MotionDensityResult {
  const sceneChangesPerSecond = scenes.length / Math.max(duration, 1);
  return { scenes, sceneChangesPerSecond };
}
