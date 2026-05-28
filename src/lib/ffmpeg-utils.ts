// ── Centralized ffmpeg/ffprobe spawn helpers ──
// All ffmpeg child processes MUST go through these wrappers so we can
// enforce CPU, I/O, and memory limits in one place.
// This prevents any single ffmpeg process from consuming all 4 cores
// and starving the Next.js app + worker of CPU.

import { spawn, ChildProcess } from "child_process";
import * as os from "os";

const FFMPEG_THREADS = 2; // Limit to 2 CPU cores
const DEFAULT_NICE = 15;  // Low CPU priority (higher = lower priority)
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── Memory-pressure guard ──────────────────────────────────
// Refuse to spawn new ffmpeg processes if system free RAM is
// critically low. This prevents the OOM killer from firing
// when multiple jobs compete for memory.
// Thresholds are tuned for host02 at 3.4–8 GB RAM.
const MIN_FREE_MB_BEFORE_SPAWN = 256;  // Absolute minimum: refuse below this
const WARN_FREE_MB = 512;              // Log warning if below this

function checkMemoryPressure(logTag: string): void {
  const freeMB = Math.round(os.freemem() / 1024 / 1024);
  if (freeMB < MIN_FREE_MB_BEFORE_SPAWN) {
    const err = new Error(
      `[${logTag}] SYSTEM MEMORY CRITICAL: ${freeMB} MB free < ${MIN_FREE_MB_BEFORE_SPAWN} MB minimum. Refusing to spawn ffmpeg to avoid OOM.`
    );
    console.error(err.message);
    throw err;
  }
  if (freeMB < WARN_FREE_MB) {
    console.warn(
      `[${logTag}] Low memory warning: ${freeMB} MB free (threshold: ${WARN_FREE_MB} MB). Proceeding but system may be under pressure.`
    );
  }
}

// Minimal env for ffmpeg children — prevents inheriting full Node.js process env
// OMP_NUM_THREADS=1 prevents ffmpeg's codec libraries (x264/x265)
// from spawning additional threads beyond ffmpeg's own -threads flag.
const leanEnv: Record<string, string> = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME || "/tmp",
  TMPDIR: process.env.TMPDIR || "/tmp",
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || "",
  OMP_NUM_THREADS: "1",
};

export interface LimitedProcess {
  proc: ChildProcess;
  kill: () => void;
}

/**
 * Spawn ffmpeg with resource limits applied.
 * Returns both the child process and a convenience kill() function.
 */
export function spawnLimitedFfmpeg(
  args: string[],
  opts?: {
    nice?: number;
    timeoutMs?: number;
    logTag?: string;
  }
): LimitedProcess {
  const nice = opts?.nice ?? DEFAULT_NICE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logTag = opts?.logTag ?? "ffmpeg";

  // Refuse to spawn if system memory is critically low
  checkMemoryPressure(logTag);

  // Prepend -threads unless caller already provided it
  const hasThreads = args.some((a) => a === "-threads");
  const finalArgs = hasThreads ? args : ["-threads", String(FFMPEG_THREADS), ...args];

  const proc = spawn("nice", ["-n", String(nice), "ffmpeg", ...finalArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...leanEnv } as typeof process.env,
  }) as ChildProcess;

  // Timeout: kill after timeoutMs to avoid runaway processes
  const timer = setTimeout(() => {
    console.warn(`[${logTag}] ffmpeg timeout (${timeoutMs}ms), sending SIGTERM`);
    proc.kill("SIGTERM");
    // Force kill after 30s grace period
    const forceTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        console.warn(`[${logTag}] ffmpeg still alive, sending SIGKILL`);
        proc.kill("SIGKILL");
      }
    }, 30000);
    // Don't let the force timer keep the process alive
    proc.on("exit", () => clearTimeout(forceTimer));
  }, timeoutMs);

  // Clear timer on exit
  proc.on("exit", () => clearTimeout(timer));
  proc.on("error", () => clearTimeout(timer));

  return {
    proc,
    kill: () => {
      clearTimeout(timer);
      proc.kill("SIGTERM");
    },
  };
}

/**
 * Spawn ffprobe with resource limits.
 * ffprobe is lighter than ffmpeg but we still want to limit threads.
 */
export function spawnLimitedFfprobe(
  args: string[],
  opts?: {
    nice?: number;
    timeoutMs?: number;
    logTag?: string;
  }
): LimitedProcess {
  const nice = opts?.nice ?? DEFAULT_NICE;
  const timeoutMs = opts?.timeoutMs ?? 30000; // 30s default for probe
  const logTag = opts?.logTag ?? "ffprobe";

  // Refuse to spawn if system memory is critically low
  checkMemoryPressure(logTag);

  const proc = spawn("nice", ["-n", String(nice), "ffprobe", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...leanEnv } as typeof process.env,
  }) as ChildProcess;

  const timer = setTimeout(() => {
    console.warn(`[${logTag}] ffprobe timeout (${timeoutMs}ms), killing`);
    proc.kill("SIGTERM");
  }, timeoutMs);

  proc.on("exit", () => clearTimeout(timer));
  proc.on("error", () => clearTimeout(timer));

  return {
    proc,
    kill: () => {
      clearTimeout(timer);
      proc.kill("SIGTERM");
    },
  };
}

/**
 * Helper: collect stdout from a child process as a string.
 * Uses streaming concatenation to avoid buffer bloat where possible,
 * but for small probe output (<10MB) this is fine.
 */
export function collectStdout(proc: { stdout: NodeJS.ReadableStream }): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    proc.stdout.on("end", () => resolve(output));
    proc.stdout.on("error", reject);
  });
}

/**
 * Helper: collect stderr from a child process as a string.
 * ffmpeg writes info/progress to stderr by convention.
 */
export function collectStderr(proc: { stderr: NodeJS.ReadableStream | null }): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!proc.stderr) return resolve("");
    let output = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    proc.stderr.on("end", () => resolve(output));
    proc.stderr.on("error", reject);
  });
}

/**
 * Wait for a child process to exit and return exit code + signal.
 */
export function waitForExit(
  proc: { on: (event: string, handler: (...args: any[]) => void) => void }
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Audio Energy Profile (US-008)
// ═══════════════════════════════════════════════════════════════════════════════

export interface AudioEnergyProfile {
  segments: Array<{ startTime: number; endTime: number; meanDb: number; maxDb: number }>;
  duration: number;
}

/**
 * Compute an audio energy profile for a video using ffmpeg volumedetect.
 *
 * MVP implementation: returns a single segment covering the full video duration
 * with overall mean_volume and max_volume. Per-second windows can be added
 * in a follow-up using asegment + astats.
 *
 * @param videoPath — absolute path to the source video
 * @returns AudioEnergyProfile with at least one segment and the total duration
 */
export async function computeAudioEnergyProfile(videoPath: string): Promise<AudioEnergyProfile> {
  const logTag = "audio-energy-profile";

  // ── 1. Get duration via ffprobe ──
  const { proc: probeProc } = spawnLimitedFfprobe(
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
    { logTag: `${logTag}-duration` }
  );

  const probeOutput = await collectStdout(probeProc);
  const { code: probeCode } = await waitForExit(probeProc);

  let duration = 0;
  if (probeCode === 0) {
    duration = parseFloat(probeOutput.trim()) || 0;
  }

  if (duration === 0) {
    return { segments: [], duration: 0 };
  }

  // ── 2. Run volumedetect on audio stream ──
  const { proc: volProc } = spawnLimitedFfmpeg(
    ["-i", videoPath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    { nice: 15, timeoutMs: 300_000, logTag: `${logTag}-volumedetect` }
  );

  const stderr = await collectStderr(volProc);
  const { code: volCode } = await waitForExit(volProc);

  if (volCode !== 0) {
    return { segments: [], duration };
  }

  // Parse mean_volume and max_volume from stderr
  const meanMatch = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const maxMatch = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);

  const meanDb = meanMatch ? parseFloat(meanMatch[1]) : -91;
  const maxDb = maxMatch ? parseFloat(maxMatch[1]) : -91;

  // MVP: single segment spanning full duration
  return {
    segments: [{ startTime: 0, endTime: duration, meanDb, maxDb }],
    duration,
  };
}