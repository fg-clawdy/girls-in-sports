import { NextResponse } from "next/server";
import { ADMIN_COOKIE_NAME, getAdminCookieOptions } from "@/lib/auth";

const ADMIN_SESSION_MAX_AGE = 4 * 60 * 60; // 4 hours

export async function POST(request: Request) {
  try {
    const { adminToken } = await request.json();

    if (!adminToken) {
      return NextResponse.json(
        { error: "Admin token is required" },
        { status: 400 }
      );
    }

    const validAdminToken = process.env.ADMIN_TOKEN;

    if (!validAdminToken) {
      return NextResponse.json(
        { error: "Admin authentication not configured" },
        { status: 500 }
      );
    }

    if (adminToken !== validAdminToken) {
      return NextResponse.json(
        { error: "Invalid admin token" },
        { status: 401 }
      );
    }

    const response = NextResponse.json({ success: true, message: "Admin session established" });
    response.cookies.set(
      ADMIN_COOKIE_NAME,
      adminToken, // store the validated token value (httpOnly so safe)
      getAdminCookieOptions(ADMIN_SESSION_MAX_AGE)
    );

    return response;
  } catch (error) {
    console.error("Admin login error:", error);
    return NextResponse.json(
      { error: "Admin login failed" },
      { status: 500 }
    );
  }
}
