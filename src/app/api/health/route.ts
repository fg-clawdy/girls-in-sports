import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const IMMICH = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";
const VENICE = (process.env.VENICE_API_URL || "https://api.venice.ai/api/v1").replace(/\/$/, "");
const VENICE_KEY = process.env.VENICE_API_KEY || "";
const WORKER_HEALTH = `http://localhost:${process.env.WORKER_HEALTH_PORT || 3011}/health`;
const startTime = Date.now();

export async function GET() {
  const requestId = Math.random().toString(36).slice(2, 10);
  const log = logger.child({ requestId, stage: "health" });

  const checks: Record<string, any> = {};

  // DB
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = { status: "ok" };
  } catch (e) {
    checks.db = { status: "fail", error: String(e) };
  }

  // Immich
  try {
    const r = await fetch(`${IMMICH}/api/server-info`, { headers: { "x-api-key": IMMICH_KEY }, signal: AbortSignal.timeout(3000) });
    checks.immich = r.ok ? { status: "ok" } : { status: "fail", code: r.status };
  } catch (e) {
    checks.immich = { status: "fail", error: String(e) };
  }

  // Venice
  try {
    const r = await fetch(`${VENICE}/models`, { headers: { Authorization: `Bearer ${VENICE_KEY}` }, signal: AbortSignal.timeout(3000) });
    checks.venice = r.ok ? { status: "ok" } : { status: "fail", code: r.status };
  } catch (e) {
    checks.venice = { status: "fail", error: String(e) };
  }

  // Worker (separate process)
  try {
    const r = await fetch(WORKER_HEALTH, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const w = await r.json();
      checks.worker = { status: "ok", ...w };
    } else {
      checks.worker = { status: "fail", code: r.status };
    }
  } catch (e) {
    checks.worker = { status: "degraded", note: "worker health not reachable (may be down or different host)", error: String(e) };
  }

  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  const overall = Object.values(checks).every((c: any) => c.status === "ok") ? "ok" : "degraded";

  log.info({ checks: Object.keys(checks), overall }, "Health check completed");

  return NextResponse.json({
    status: overall,
    checks,
    version: "0.1.0",
    uptimeSec,
    timestamp: new Date().toISOString(),
  });
}
