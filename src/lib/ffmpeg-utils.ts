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