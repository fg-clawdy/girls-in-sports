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

setupGracefulShutdown();
startHealthServer(HEALTH_PORT);
startWorker();
