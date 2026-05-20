#!/usr/bin/env node
// Standalone script for cron job: runs feedback analysis
// Usage: npx ts-node src/scripts/run-feedback-analysis.ts

import { config } from "dotenv";
config({ path: ".env.local" });

import { runFeedbackAnalysis } from "../lib/feedback-analysis";

async function main() {
  try {
    console.log("[cron-feedback] Starting weekly feedback analysis...");
    const result = await runFeedbackAnalysis();
    console.log(`[cron-feedback] Analysis complete: ${result.id}`);
    console.log(`[cron-feedback] Recommendations:\n${result.recommendations}`);
    process.exit(0);
  } catch (error) {
    console.error("[cron-feedback] Failed:", error);
    process.exit(1);
  }
}

main();
