import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * US-001: Middleware is now thin.
 * - Persistent DB-backed rate limiting (RateLimit model) is enforced inside
 *   requireAdmin() for all protected admin routes and via the shared rate-limiter
 *   pattern for other paths in future stories.
 * - The previous in-memory Map + token bucket has been removed entirely per PRD.
 * - We still set security headers on all /api responses.
 */

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Only touch API routes for headers
  if (!path.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Allow health checks through without extra work
  if (path === "/api/health") {
    return NextResponse.next();
  }

  // Security headers only (rate enforcement moved to Node runtime via requireAdmin / future shared lib)
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
