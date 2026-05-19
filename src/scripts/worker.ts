#!/usr/bin/env node
// Standalone worker entry point
// Run: npx ts-node src/scripts/worker.ts
// Or after build: node dist/scripts/worker.js

import {
  startWorker,
  startHealthServer,
  setupGracefulShutdown,
} from "../lib/job-worker";

const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || "3011", 10);

setupGracefulShutdown();
startHealthServer(HEALTH_PORT);
startWorker();
