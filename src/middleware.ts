import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Simple in-memory token bucket rate limiter
interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();
const CLEANUP_INTERVAL_MS = 60000;

// Default limits
const DEFAULT_RATE = 60; // requests per minute
const UPLOAD_RATE = 10;  // requests per minute for upload routes

function getRateLimit(path: string): number {
  if (path.includes("/upload")) return UPLOAD_RATE;
  return DEFAULT_RATE;
}

function getBucketKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || req.ip || "unknown";
  return `${ip}:${req.nextUrl.pathname}`;
}

function isAllowed(key: string, rate: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: rate, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens
  const elapsed = (now - bucket.lastRefill) / 1000; // seconds
  const refill = Math.floor(elapsed * (rate / 60)); // tokens per second
  bucket.tokens = Math.min(rate, bucket.tokens + refill);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

// Periodic cleanup to prevent memory growth
if (typeof globalThis !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    const entries = Array.from(buckets.entries());
    for (const [key, bucket] of entries) {
      if (now - bucket.lastRefill > CLEANUP_INTERVAL_MS * 5) {
        buckets.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

export function middleware(request: NextRequest) {
  // Skip rate limiting for non-API routes and static files
  const path = request.nextUrl.pathname;
  if (!path.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Skip health checks
  if (path === "/api/health") {
    return NextResponse.next();
  }

  const rate = getRateLimit(path);
  const key = getBucketKey(request);

  if (!isAllowed(key, rate)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  // Security headers
  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-DNS-Prefetch-Control", "off");

  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
