import { PrismaClient, JobType, JobStatus } from "@prisma/client";
export { JobType, JobStatus };
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createServer, IncomingMessage, ServerResponse } from "http";
import * as os from "os";
import { sendPushNotification } from "./push";
import { logger, createLogger } from "./logger";
import { Worker, Job } from "bullmq";
import { getQueue, getQueueConfig } from "./queues";

let _prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!_prisma) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const STALE_RUNNING_MINUTES = 30;

export type JobHandler = (args: { payload: unknown; jobId: string }) => Promise<void>;

const handlers = new Map<JobType, JobHandler>();

export function registerHandler(type: JobType, handler: JobHandler) {
  handlers.set(type, handler);
}

// ── Stale Job Reclaimer ─────────────────────────────────────

async function reclaimStaleJobs() {
  const staleThreshold = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000).toISOString();
  const result = await getPrisma().$queryRaw<Array<{ id: string; type: string }>>`
    UPDATE "jobs"
    SET status = 'QUEUED', "startedAt" = NULL, attempts = LEAST(attempts + 1, "maxAttempts")
    WHERE status = 'RUNNING'
      AND ("startedAt" IS NULL OR "startedAt" < ${staleThreshold})
    RETURNING id, type::text
  `;
  if (result.length > 0) {
    logger.info({ count: result.length, jobs: result.map((r) => r.id) }, 'Reclaimed stale RUNNING jobs');
    // Re-enqueue stale jobs into BullMQ so they get picked up
    for (const job of result) {
      try {
        const queue = getQueue(job.type as JobType);
        await queue.add(job.type, { dbJobId: job.id }, { jobId: job.id });
      } catch (err) {
        logger.error({ jobId: job.id, error: String(err) }, 'Failed to re-enqueue reclaimed job');
      }
    }
  }
}

// ── Enqueue Job (called from Next.js API routes) ──────────────

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown> | unknown[],
  parentJobId?: string
) {
  // 1. Create PostgreSQL record (source of truth for audit/status/push)
  const job = await getPrisma().job.create({
    data: {
      type,
      payload: JSON.parse(JSON.stringify(payload)),
      parentJobId: parentJobId ?? null,
      status: JobStatus.QUEUED,
      attempts: 0,
      maxAttempts: 3,
    },
  });

  // 2. Enqueue to BullMQ (for queue mechanics: concurrency, rate limiting, backoff)
  const queue = getQueue(type);
  await queue.add(type, { dbJobId: job.id, payload }, { jobId: job.id });

  return job;
}

// ── Job Completion / Failure (update DB record) ──────────────

async function markDone(dbJobId: string, jobType: JobType, payload: unknown) {
  await getPrisma().job.update({
    where: { id: dbJobId },
    data: {
      status: JobStatus.DONE,
      completedAt: new Date(),
      error: null,
    },
  });

  // Send push notifications for stage-completing job types
  const stageCompletingTypes: JobType[] = [
    JobType.SCORE_CLIP,
    JobType.DIRECT_SCRIPT,
    JobType.RENDER_PROXY,
    JobType.RENDER_FINAL,
  ];

  if (stageCompletingTypes.includes(jobType)) {
    const pl = (payload ?? {}) as Record<string, unknown>;
    const eventName = (pl.eventName as string) || "Your event";

    let title = "Girls In Sports";
    let body = "A background job completed.";
    let url = "/";

    switch (jobType) {
      case JobType.SCORE_CLIP:
        if (pl.parentJobId) {
          const pending = await getPrisma().job.count({
            where: {
              parentJobId: pl.parentJobId as string,
              status: { not: JobStatus.DONE },
            },
          });
          if (pending > 0) return;
        }
        title = "Footage Ready";
        body = `${eventName} footage is ready — clips scored and tagged.`;
        url = pl.eventId ? `/events/${pl.eventId}/curate` : "/";
        break;
      case JobType.DIRECT_SCRIPT:
        title = "Script Ready";
        body = `Your campaign script for ${eventName} is ready.`;
        url = pl.campaignId ? `/campaigns/${pl.campaignId}/preview` : "/";
        break;
      case JobType.RENDER_PROXY:
        title = "Rough Draft Ready";
        body = `Your rough draft for ${eventName} is ready to preview.`;
        url = pl.campaignId ? `/campaigns/${pl.campaignId}/preview` : "/";
        break;
      case JobType.RENDER_FINAL:
        title = "Final Render Ready";
        body = `Your campaign video for ${eventName} is ready to download.`;
        url = pl.campaignId ? `/campaigns/${pl.campaignId}/download` : "/";
        break;
    }

    try {
      await sendPushNotification(null, { title, body, url });
    } catch (err) {
      logger.error({ stage: 'push', error: String(err) }, 'Push notification failed');
    }
  }
}

async function markFailed(
  dbJobId: string,
  jobType: JobType,
  error: string,
  attempts: number,
  maxAttempts: number
) {
  const shouldRetry = attempts < maxAttempts;
  const MAX_RETRY_DELAY_MS = 60000;
  const delayMs = Math.min(
    Math.pow(2, attempts) * 1000,
    MAX_RETRY_DELAY_MS
  );
  const retryAfter = new Date(Date.now() + delayMs);

  await getPrisma().job.update({
    where: { id: dbJobId },
    data: shouldRetry
      ? {
          status: JobStatus.RETRYING,
          attempts: attempts + 1,
          error,
          retryAfter,
        }
      : {
          status: JobStatus.FAILED,
          error,
          completedAt: new Date(),
        },
  });
}

// ── BullMQ Worker Setup ────────────────────────────────────────

let isShuttingDown = false;
let jobsProcessed = 0;
let jobsFailed = 0;
const startTime = Date.now();
const allWorkers: Worker[] = [];

export async function startWorker() {
  logger.info({ stage: 'worker' }, 'Starting BullMQ job worker');

  // Reclaim any jobs left RUNNING by a previous crashed worker instance
  await reclaimStaleJobs();

  // Create a BullMQ Worker for each registered handler
  for (const [jobType, handler] of handlers) {
    const config = getQueueConfig(jobType);

    const worker = new Worker(
      jobType as string,
      async (bullJob: Job) => {
        const start = Date.now();
        const dbJobId = (bullJob.data?.dbJobId as string) || bullJob.id || "unknown";
        const payload = bullJob.data?.payload ?? bullJob.data;
        const log = createLogger({ jobId: dbJobId, jobType, stage: 'worker' });

        log.info('Job started (BullMQ)');

        // Update DB status to RUNNING
        try {
          await getPrisma().job.update({
            where: { id: dbJobId },
            data: { status: JobStatus.RUNNING, startedAt: new Date() },
          });
        } catch {
          // DB row might not exist (e.g., reclaimed stale job or direct BullMQ enqueue)
          log.warn('No DB job row found for update to RUNNING');
        }

        try {
          // Defensive: legacy double-encoded string payloads
          let processedPayload = payload;
          if (typeof processedPayload === "string") {
            try {
              processedPayload = JSON.parse(processedPayload);
            } catch {
              // leave as-is
            }
          }

          await handler({ payload: processedPayload, jobId: dbJobId });
          await markDone(dbJobId, jobType, payload);
          jobsProcessed++;
          log.info({ durationMs: Date.now() - start }, 'Job completed');
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          jobsFailed++;
          log.error({ error: errorMsg, durationMs: Date.now() - start }, 'Job failed');

          const attemptNum = bullJob.attemptsMade + 1;
          const maxAttempts = bullJob.opts?.attempts ?? 3;
          await markFailed(dbJobId, jobType, errorMsg, attemptNum, maxAttempts);

          // Re-throw so BullMQ handles retry/backoff
          throw err;
        }
      },
      {
        connection: { url: REDIS_URL },
        concurrency: config.concurrency,
        limiter: config.limiter
          ? {
              max: config.limiter.max,
              duration: config.limiter.duration,
            }
          : undefined,
        // Don't remove jobs on completion — we track in DB
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      }
    );

    worker.on("error", (err) => {
      logger.error({ stage: "worker", workerType: jobType, error: String(err) }, "BullMQ worker error");
    });

    worker.on("failed", (bullJob, err) => {
      if (bullJob) {
        logger.warn(
          { stage: "worker", jobId: bullJob.id, attempts: bullJob.attemptsMade, error: String(err) },
          "BullMQ job failed (will retry if attempts remain)"
        );
      }
    });

    allWorkers.push(worker);
    logger.info({ stage: "worker", workerType: jobType, concurrency: config.concurrency }, "BullMQ worker started");
  }

  logger.info({ stage: "worker", workerCount: allWorkers.length }, "All BullMQ workers started");

  // Periodic stale job patrol: reclaim RUNNING jobs that got orphaned by
  // network hangs, worker stalls, or unhandled promise rejections.
  // Reclaimer at startup handles boot-time orphans; this catches mid-flight ones.
  const RECLAIM_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  setInterval(async () => {
    try {
      await reclaimStaleJobs();
    } catch (err) {
      logger.error({ stage: "worker", error: String(err) }, "Periodic stale job reclaim failed");
    }
  }, RECLAIM_INTERVAL_MS);
}

export function stopWorker() {
  isShuttingDown = true;
}

// ── Health HTTP Server ────────────────────────────────────────

export function startHealthServer(port = 3011) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      try {
        const queueDepth = await getPrisma().job.count({
          where: {
            status: { in: [JobStatus.QUEUED, JobStatus.RETRYING] },
          },
        });
        const runningJobs = await getPrisma().job.count({
          where: { status: JobStatus.RUNNING },
        });

        const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
        const failureRate = jobsProcessed > 0 ? jobsFailed / jobsProcessed : 0;
        const memUsage = process.memoryUsage();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          backend: "bullmq",
          queueDepth,
          runningJobs,
          jobsProcessed,
          jobsFailed,
          failureRate: Number(failureRate.toFixed(4)),
          uptimeSec,
          version: "0.2.0",
          worker: "running",
          memory: {
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            rssMB: Math.round(memUsage.rss / 1024 / 1024),
            externalMB: Math.round(memUsage.external / 1024 / 1024),
          },
          system: {
            freeMemMB: Math.round(os.freemem() / 1024 / 1024),
            totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
            loadAvg1m: os.loadavg()[0],
            loadAvg5m: os.loadavg()[1],
            loadAvg15m: os.loadavg()[2],
          },
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: String(err) }));
      }
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    logger.info({ stage: 'health', port }, 'Health endpoint listening');
  });

  return server;
}

// ── Graceful Shutdown ───────────────────────────────────────────

export function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    logger.info({ stage: 'worker', signal }, 'Shutdown signal received');
    isShuttingDown = true;

    // Close BullMQ workers first (stop accepting new jobs, finish in-progress)
    await Promise.all(allWorkers.map((w) => w.close()));
    logger.info({ stage: 'worker' }, 'All BullMQ workers closed');

    // Close DB connection
    await getPrisma().$disconnect();
    logger.info({ stage: 'worker' }, 'Prisma disconnected');

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}