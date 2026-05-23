#!/usr/bin/env node
// Standalone worker entry point
// Run: npx tsx src/scripts/worker.ts

import { config } from "dotenv";
config();

import {
  startWorker,
  startHealthServer,
  setupGracefulShutdown,
  registerHandler,
  JobType,
} from "../lib/job-worker";

const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || "3011", 10);

// Lazy-load handlers after dotenv has initialized env vars
// This avoids ESM import hoisting evaluating handler modules before config() runs

registerHandler(JobType.INGEST_CLIP, async ({ payload }) => {
  const { handleIngestClip } = await import("../lib/handlers/ingest-clip");
  await handleIngestClip(payload);
});

registerHandler(JobType.SCORE_CLIP, async ({ payload, jobId }) => {
  const { handleScoreClip } = await import("../lib/handlers/score-clip");
  await handleScoreClip({ payload, jobId });
});

registerHandler(JobType.DIRECT_SCRIPT, async ({ payload, jobId }) => {
  const { handleDirectScript } = await import("../lib/handlers/direct-script");
  await handleDirectScript({ payload, jobId });
});

registerHandler(JobType.GENERATE_MUSIC, async ({ payload, jobId }) => {
  const { handleGenerateMusic } = await import("../lib/handlers/generate-music");
  await handleGenerateMusic({ payload, jobId });
});

registerHandler(JobType.RENDER_PROXY, async ({ payload, jobId }) => {
  const { handleRenderProxy } = await import("../lib/handlers/render-proxy");
  await handleRenderProxy({ payload, jobId });
});

registerHandler(JobType.RENDER_FINAL, async ({ payload, jobId }) => {
  const { handleRenderFinal } = await import("../lib/handlers/render-final");
  await handleRenderFinal({ payload, jobId });
});

registerHandler(JobType.FEEDBACK_ANALYSIS, async ({ payload, jobId }) => {
  const { runFeedbackAnalysis } = await import("../lib/feedback-analysis");
  await runFeedbackAnalysis();
});

registerHandler(JobType.WEEKLY_CRITIQUE, async ({ payload, jobId }) => {
  const { generateWeeklyCritique } = await import("../lib/weekly-critique-service");
  const weekStart = (payload as any)?.weekStart ? new Date((payload as any).weekStart) : undefined;
  await generateWeeklyCritique(weekStart);
});

setupGracefulShutdown();
startHealthServer(HEALTH_PORT);
startWorker();

// US-001: Daily cleanup of expired RateLimit rows (prevents table bloat; "weekly" per PRD can be daily for safety)
setInterval(async () => {
  try {
    const { prisma } = await import("../lib/prisma");
    const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2); // older than 2 days
    const deleted = await prisma.rateLimit.deleteMany({
      where: { resetAt: { lt: cutoff } },
    });
    if (deleted.count > 0) {
      console.log(`[worker] Cleaned ${deleted.count} expired rate-limit buckets`);
    }
  } catch (e) {
    console.error("[worker] RateLimit cleanup failed (non-fatal):", e);
  }
}, 1000 * 60 * 60 * 24); // once per day
