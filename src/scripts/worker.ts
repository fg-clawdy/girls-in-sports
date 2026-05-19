#!/usr/bin/env node
// Standalone worker entry point
// Run: npx ts-node src/scripts/worker.ts
// Or after build: node dist/scripts/worker.js

import {
  startWorker,
  startHealthServer,
  setupGracefulShutdown,
  registerHandler,
  JobType,
} from "../lib/job-worker";
import { handleIngestClip } from "../lib/handlers/ingest-clip";

const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || "3011", 10);

registerHandler(JobType.INGEST_CLIP, handleIngestClip as any);

setupGracefulShutdown();
startHealthServer(HEALTH_PORT);
startWorker();
