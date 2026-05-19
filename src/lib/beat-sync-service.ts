// Beat detection service for GIS
// Wraps librosa-based Python script for BPM/beat timestamp extraction

import { spawn } from "child_process";
import * as path from "path";

const SCRIPT_PATH = path.resolve(
  process.cwd(),
  "scripts",
  "analyze_beats.py"
);

export interface BeatAnalysis {
  bpm: number;
  beatTimestamps: number[];
  confidence: number; // 0-1 beat strength
}

/**
 * Analyze beats in an audio/video file using librosa.
 * Returns BPM and beat timestamps for sync-aware editing.
 */
export async function analyzeBeats(
  filePath: string
): Promise<BeatAnalysis> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [SCRIPT_PATH, filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Beat analysis failed: ${stderr || "exit code " + code}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          reject(new Error(result.error));
          return;
        }
        resolve({
          bpm: result.bpm,
          beatTimestamps: result.beatTimestamps,
          confidence: result.confidence,
        });
      } catch (err) {
        reject(new Error(`Failed to parse beat analysis output: ${stdout.slice(0, 500)}`));
      }
    });

    proc.on("error", reject);
  });
}

/**
 * Find the nearest beat timestamp for a given time.
 * Useful for snapping clip start/end times to beats.
 */
export function snapToNearestBeat(
  time: number,
  beatTimestamps: number[]
): { snappedTime: number; distance: number } {
  if (beatTimestamps.length === 0) return { snappedTime: time, distance: Infinity };

  let nearest = beatTimestamps[0];
  let minDist = Math.abs(time - nearest);

  for (const bt of beatTimestamps) {
    const dist = Math.abs(time - bt);
    if (dist < minDist) {
      minDist = dist;
      nearest = bt;
    }
  }

  return { snappedTime: nearest, distance: minDist };
}

/**
 * Given a desired duration, find the closest beat-aligned duration.
 * Uses the interval between consecutive beats as the rhythmic unit.
 */
export function getBeatAlignedDuration(
  targetDuration: number,
  beatTimestamps: number[],
  maxDuration: number
): number {
  if (beatTimestamps.length < 2) return Math.min(targetDuration, maxDuration);

  // Compute average beat interval (in seconds)
  let totalInterval = 0;
  let intervals = 0;
  for (let i = 1; i < beatTimestamps.length; i++) {
    totalInterval += beatTimestamps[i] - beatTimestamps[i - 1];
    intervals++;
  }
  const avgBeatInterval = intervals > 0 ? totalInterval / intervals : 0.5;

  // Find how many beats would best match the target duration
  const targetBeats = targetDuration / avgBeatInterval;
  const nearestBeats = Math.max(1, Math.round(targetBeats));

  // Calculate the aligned duration
  const alignedDuration = nearestBeats * avgBeatInterval;

  // Clamp to maxDuration and minimum of 0.5s
  return Math.max(0.5, Math.min(alignedDuration, maxDuration));
}
