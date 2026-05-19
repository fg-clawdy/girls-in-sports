import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyToken, AUTH_COOKIE_NAME } from "./lib/auth";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes - no auth required
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth")
  ) {
    return NextResponse.next();
  }

  // Check auth token
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const isValid = token ? verifyToken(token) : false;

  // Protect all other routes
  if (!isValid) {
    // For API routes, return 401 JSON instead of redirecting to login page
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Unauthorized — please log in again" },
        { status: 401 }
      );
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Refresh cookie on each authenticated request
  const response = NextResponse.next();
  response.cookies.set(AUTH_COOKIE_NAME, token!, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });

  // Prevent caching of authenticated pages
  response.headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
