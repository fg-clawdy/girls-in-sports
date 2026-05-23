import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, ADMIN_COOKIE_NAME, getAuthCookieOptions, getAdminCookieOptions } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json({ success: true });
  // Clear normal user session
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    ...getAuthCookieOptions(0),
    maxAge: 0,
  });
  // Clear admin session (US-001)
  response.cookies.set(ADMIN_COOKIE_NAME, "", {
    ...getAdminCookieOptions(0),
    maxAge: 0,
  });
  return response;
}
