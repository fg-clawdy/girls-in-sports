import * as jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { NextResponse, NextRequest } from "next/server";
import { prisma } from "./prisma";
import { getEnv } from "./env";

const JWT_SECRET = process.env.JWT_SECRET || "gis-local-secret-change-me";
const JWT_EXPIRES_IN = "30d";

export const AUTH_COOKIE_NAME = "gis_auth_token";
export const ADMIN_COOKIE_NAME = "gis-admin-session";
const ADMIN_SESSION_MAX_AGE = 4 * 60 * 60; // 4 hours short-lived for admin sessions

export function getAuthCookieOptions(maxAge: number) {
  const isSecure =
    process.env.AUTH_SECURE === "true" || process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    maxAge,
    path: "/",
  };
}

export function getAdminCookieOptions(maxAge: number) {
  const isSecure =
    process.env.ADMIN_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "strict" as const,
    maxAge,
    path: "/",
  };
}

export function generateToken(): string {
  return jwt.sign({ authenticated: true }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return false;
  return verifyToken(token);
}

export async function getAuthToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(AUTH_COOKIE_NAME)?.value;
}

// --- US-001 Admin hardening ---

export function getClientIp(request: Request | NextRequest): string {
  const headers = "headers" in request ? request.headers : (request as any).headers;
  const forwarded = headers.get?.("x-forwarded-for") || headers.get?.("X-Forwarded-For");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  // @ts-ignore - NextRequest has .ip in some runtimes
  return (request as any).ip || "unknown";
}

function isIpAllowed(ip: string, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (ip === "unknown" || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.0.0.1")) {
    return true; // localhost always allowed (dev + prod health)
  }
  for (const entry of allowlist) {
    if (!entry) continue;
    if (entry === ip) return true;
    // Simple prefix support for /8 /16 /24 style (e.g. "192.168.1.")
    if (entry.endsWith(".") && ip.startsWith(entry)) return true;
    if (entry.includes("/") ) {
      // naive CIDR: for /24 check first 3 octets etc. (sufficient for internal use)
      const [net, bitsStr] = entry.split("/");
      const bits = parseInt(bitsStr || "32", 10);
      if (bits >= 24 && ip.startsWith(net.substring(0, net.lastIndexOf(".") + 1))) return true;
      if (bits >= 16 && ip.startsWith(net.substring(0, net.lastIndexOf(".", net.lastIndexOf(".") - 1) + 1))) return true;
    }
  }
  return false;
}

async function checkRateLimit(key: string): Promise<boolean> {
  const env = getEnv();
  const maxTokens = env.RATE_LIMIT_TOKENS ?? 60;
  const windowMs = env.RATE_LIMIT_WINDOW_MS ?? 60000;
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);

  try {
    const record = await prisma.rateLimit.findUnique({ where: { key } });

    if (!record || record.resetAt < now) {
      // (re)create fresh bucket
      await prisma.rateLimit.upsert({
        where: { key },
        create: { key, tokens: maxTokens - 1, resetAt },
        update: { tokens: maxTokens - 1, resetAt },
      });
      return true;
    }

    if (record.tokens <= 0) {
      return false;
    }

    await prisma.rateLimit.update({
      where: { key },
      data: { tokens: { decrement: 1 } },
    });
    return true;
  } catch (err) {
    // On DB failure for rate limit, fail closed (conservative for prod readiness)
    console.error("[rate-limit] DB error, denying request to protect backend:", err);
    return false;
  }
}

async function writeAdminAuditLog(params: {
  actor: string;
  action: string;
  route: string;
  eventId?: string;
  costEstimate?: number;
  ip?: string;
  success: boolean;
  errorMessage?: string;
}) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actor: params.actor,
        action: params.action,
        route: params.route,
        eventId: params.eventId || null,
        costEstimate: params.costEstimate || null,
        ip: params.ip || null,
        success: params.success,
        errorMessage: params.errorMessage || null,
      },
    });
  } catch (err) {
    // Audit failure must never break the request path
    console.error("[admin-audit] Failed to write audit log (non-fatal):", err);
  }
}

export async function requireAdmin(
  request: Request | NextRequest
): Promise<{ allowed: true } | NextResponse> {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json(
      { error: "Admin authentication not configured (ADMIN_TOKEN missing)" },
      { status: 500 }
    );
  }

  // 1. Extract token: header (scripts/cron) or cookie (UI admin pages)
  let provided: string | undefined = request.headers.get("x-admin-token") || request.headers.get("X-Admin-Token") || undefined;

  if (!provided) {
    const cookieStore = await cookies();
    provided = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  }

  const ip = getClientIp(request);
  const pathname = new URL((request as any).url || "http://localhost").pathname;

  if (!provided || provided !== adminToken) {
    await writeAdminAuditLog({
      actor: "unknown",
      action: "admin-access-denied",
      route: pathname,
      ip,
      success: false,
      errorMessage: "Missing or invalid admin token",
    });
    return NextResponse.json({ error: "Admin token required" }, { status: 401 });
  }

  // 3. IP allowlist (production only)
  const allowlist = (process.env.ADMIN_IP_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production" && allowlist.length > 0 && !isIpAllowed(ip, allowlist)) {
    await writeAdminAuditLog({
      actor: "admin",
      action: "admin-access-denied",
      route: pathname,
      ip,
      success: false,
      errorMessage: "IP not in allowlist",
    });
    return NextResponse.json({ error: "IP address not allowed" }, { status: 403 });
  }

  // 4. DB-backed rate limit (shared with general middleware paths via requireAdmin for admin routes)
  const rateOk = await checkRateLimit(`admin:${ip}`);
  if (!rateOk) {
    await writeAdminAuditLog({
      actor: "admin",
      action: "admin-access-denied",
      route: pathname,
      ip,
      success: false,
      errorMessage: "Rate limit exceeded",
    });
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  // 5. Success audit + allow
  await writeAdminAuditLog({
    actor: "admin",
    action: "admin-access-granted",
    route: pathname,
    ip,
    success: true,
  });

  return { allowed: true };
}
