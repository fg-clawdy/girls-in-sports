// ── BullMQ Queue Definitions ──
// Rate limits and concurrency per §2.8 of OOM-ANALYSIS-AND-SOLUTIONS.md:
//   ingest:  concurrency 2, max 2 per 30s   (2 safe at 8 GB; scene detect ~600MB each)
//   score:   concurrency 2, max 2 per 10s   (ffprobe + AI calls are lightweight)
//   render:  concurrency 1, max 1 per 60s   (heavy ffmpeg encoding — keep serial)
//   default: concurrency 1, no rate limit    (lightweight jobs)
//
// §4.1 Parallel Uploads (2026-05-26):
//   INGEST_CLIP concurrency raised 1→2. At 8 GB RAM, two scene detections
//   (~600 MB each) = 1.2 GB peak, within 5.1 GB headroom. Rate limiter
//   (2 per 30s) allows both to start within the same window.
//   SCORE_CLIP concurrency raised 1→2. ffprobe + Venice API calls are IO-bound.

import { Queue, QueueOptions } from "bullmq";
import { JobType } from "@prisma/client";
import { logger } from "./logger";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Shared connection for all queues
const connection = { url: REDIS_URL };

// ── Per-queue-type configuration ──

interface QueueConfig {
  concurrency: number;
  limiter?: { max: number; duration: number }; // duration in ms
}

const QUEUE_CONFIGS: Record<string, QueueConfig> = {
  [JobType.INGEST_CLIP]: {
    concurrency: 2,
    limiter: { max: 2, duration: 30_000 },
  },
  [JobType.SCORE_CLIP]: {
    concurrency: 2,
    limiter: { max: 2, duration: 10_000 },
  },
  [JobType.RENDER_PROXY]: {
    concurrency: 1,
    limiter: { max: 1, duration: 60_000 },
  },
  [JobType.RENDER_FINAL]: {
    concurrency: 1,
    limiter: { max: 1, duration: 60_000 },
  },
  // Lightweight jobs — no rate limit needed
  [JobType.DIRECT_SCRIPT]: { concurrency: 2 },
  [JobType.GENERATE_MUSIC]: { concurrency: 1 },
  [JobType.FEEDBACK_ANALYSIS]: { concurrency: 1 },
  [JobType.WEEKLY_CRITIQUE]: { concurrency: 1 },
};

const DEFAULT_QUEUE_CONFIG: QueueConfig = { concurrency: 1 };

// ── Global pause/resume for memory pressure ──

let queuesPaused = false;
const allQueues: Queue[] = [];

export function isQueuesPaused(): boolean {
  return queuesPaused;
}

export async function pauseAllQueues(): Promise<void> {
  if (queuesPaused) return;
  queuesPaused = true;
  logger.warn({ stage: "queues" }, "Pausing all BullMQ queues due to memory pressure");
  await Promise.all(allQueues.map((q) => q.pause()));
}

export async function resumeAllQueues(): Promise<void> {
  if (!queuesPaused) return;
  queuesPaused = false;
  logger.info({ stage: "queues" }, "Resuming all BullMQ queues");
  await Promise.all(allQueues.map((q) => q.resume()));
}

// ── Queue factory (lazy, cached) ──

const queueCache = new Map<string, Queue>();

export function getQueue(jobType: JobType): Queue {
  const key = jobType as string;
  if (!queueCache.has(key)) {
    const opts: QueueOptions = {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 3600 * 24 }, // keep completed 24h for inspection
        removeOnFail: { age: 3600 * 24 * 7 }, // keep failed 7 days
      },
    };
    const q = new Queue(key, opts);
    allQueues.push(q);
    queueCache.set(key, q);
    logger.info({ stage: "queues", queue: key }, "BullMQ queue initialized");
  }
  return queueCache.get(key)!;
}

export function getQueueConfig(jobType: JobType): QueueConfig {
  return QUEUE_CONFIGS[jobType as string] ?? DEFAULT_QUEUE_CONFIG;
}

// ── Graceful shutdown ──

export async function closeAllQueues(): Promise<void> {
  logger.info({ stage: "queues" }, "Closing all BullMQ queues");
  await Promise.all(allQueues.map((q) => q.close()));
  allQueues.length = 0;
  queueCache.clear();
}