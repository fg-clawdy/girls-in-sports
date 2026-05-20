#!/usr/bin/env node
// Standalone worker entry point
// Run: npx ts-node src/scripts/worker.ts
// Or after build: node dist/scripts/worker.js

import { config } from "dotenv";
config();

import {
  startWorker,
  startHealthServer,
  setupGracefulShutdown,
  registerHandler,
  JobType,
} from "../lib/job-worker";
import { handleIngestClip } from "../lib/handlers/ingest-clip";
import { handleScoreClip } from "../lib/handlers/score-clip";
import { handleDirectScript } from "../lib/handlers/direct-script";
import { handleGenerateMusic } from "../lib/handlers/generate-music";
import { handleRenderProxy } from "../lib/handlers/render-proxy";
import { handleRenderFinal } from "../lib/handlers/render-final";

const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || "3011", 10);

registerHandler(JobType.INGEST_CLIP, async ({ payload }) => {
  await handleIngestClip(payload);
});
registerHandler(JobType.SCORE_CLIP, async ({ payload, jobId }) => {
  await handleScoreClip({ payload, jobId });
});
registerHandler(JobType.DIRECT_SCRIPT, async ({ payload, jobId }) => {
  await handleDirectScript({ payload, jobId });
});
registerHandler(JobType.GENERATE_MUSIC, async ({ payload, jobId }) => {
  await handleGenerateMusic({ payload, jobId });
});
registerHandler(JobType.RENDER_PROXY, async ({ payload, jobId }) => {
  await handleRenderProxy({ payload, jobId });
});
registerHandler(JobType.RENDER_FINAL, async ({ payload, jobId }) => {
  await handleRenderFinal({ payload, jobId });
});

setupGracefulShutdown();
startHealthServer(HEALTH_PORT);
startWorker();
