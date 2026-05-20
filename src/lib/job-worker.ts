import { PrismaClient, JobType, JobStatus } from "@prisma/client";
export { JobType, JobStatus };
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { sendPushNotification } from "./push";

let _prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!_prisma) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

const POLL_INTERVAL_MS = 2000;
const MAX_RETRY_DELAY_MS = 60000;

export type JobHandler = (args: { payload: unknown; jobId: string }) => Promise<void>;

const handlers = new Map<JobType, JobHandler>();

export function registerHandler(type: JobType, handler: JobHandler) {
  handlers.set(type, handler);
}

// ── Enqueue Job (called from Next.js API routes) ──────────────

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown> | unknown[],
  parentJobId?: string
) {
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
  return job;
}

// ── Atomic Job Claim ──────────────────────────────────────────

async function claimNextJob() {
  // Claim atomically using raw query to avoid race conditions
  const now = new Date().toISOString();
  const result = await getPrisma().$queryRaw<Array<{
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
  }>>`
    UPDATE "jobs"
    SET status = 'RUNNING', "startedAt" = ${now}
    WHERE id = (
      SELECT id FROM "jobs"
      WHERE status = 'QUEUED'
        AND ("retryAfter" IS NULL OR "retryAfter" <= ${now})
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type::text, payload, attempts, "maxAttempts"
  `;

  return result[0] || null;
}

// ── Job Processing ────────────────────────────────────────────

async function processJob(job: {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}) {
  const handler = handlers.get(job.type as JobType);

  if (!handler) {
    throw new Error(`No handler registered for job type: ${job.type}`);
  }

  // Defensive: legacy double-encoded string payloads (ingest-clip.ts used JSON.stringify before fix)
  let payload = job.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      // leave as-is if unparseable
    }
  }

  await handler({ payload, jobId: job.id });
}

async function markDone(jobId: string, jobType: JobType, payload: unknown) {
  await getPrisma().job.update({
    where: { id: jobId },
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
        // Only notify when all clips scored — check via parentJobId
        if (pl.parentJobId) {
          const pending = await getPrisma().job.count({
            where: {
              parentJobId: pl.parentJobId as string,
              status: { not: JobStatus.DONE },
            },
          });
          if (pending > 0) return; // Still scoring other clips
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
      console.error("[worker] Push notification failed:", err);
    }
  }
}

async function markFailed(jobId: string, error: string, attempts: number, maxAttempts: number) {
  const shouldRetry = attempts < maxAttempts;
  const delayMs = Math.min(
    Math.pow(2, attempts) * 1000,
    MAX_RETRY_DELAY_MS
  );
  const retryAfter = new Date(Date.now() + delayMs);

  await getPrisma().job.update({
    where: { id: jobId },
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

// ── Main Loop ─────────────────────────────────────────────────

let isShuttingDown = false;

export async function startWorker() {
  console.log("[worker] Starting job worker...");

  while (!isShuttingDown) {
    try {
      const job = await claimNextJob();

      if (job) {
        console.log(`[worker] Claimed job ${job.id} (${job.type})`);
        try {
          await processJob(job);
          await markDone(job.id, job.type as JobType, job.payload);
          console.log(`[worker] Job ${job.id} completed`);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[worker] Job ${job.id} failed: ${errorMsg}`);
          await markFailed(job.id, errorMsg, job.attempts, job.maxAttempts);
        }
      }
    } catch (err) {
      console.error("[worker] Error in main loop:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.log("[worker] Shutting down...");
  await getPrisma().$disconnect();
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

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", queueDepth, runningJobs }));
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
    console.log(`[worker] Health endpoint listening on port ${port}`);
  });

  return server;
}

// ── Graceful Shutdown ───────────────────────────────────────────

export function setupGracefulShutdown() {
  process.on("SIGINT", () => {
    console.log("\n[worker] SIGINT received");
    stopWorker();
  });

  process.on("SIGTERM", () => {
    console.log("\n[worker] SIGTERM received");
    stopWorker();
  });
}
