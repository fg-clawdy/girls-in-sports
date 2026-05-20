import { NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";

const JWT_SECRET = new TextEncoder().encode(
  process.env.SHARE_JWT_SECRET || process.env.NEXTAUTH_SECRET || "gis-share-secret-fallback"
);

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

export async function GET(
  _request: Request,
  { params }: { params: { token: string } }
) {
  try {
    const { payload } = await jwtVerify(params.token, JWT_SECRET, {
      clockTolerance: 60,
    });

    const campaignId = payload.campaignId as string;
    const immichAssetId = payload.immichAssetId as string;

    if (!campaignId || !immichAssetId) {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    // Proxy video from Immich inline (no download disposition)
    if (!IMMICH_URL || !IMMICH_KEY) {
      return NextResponse.json({ error: "Immich not configured" }, { status: 503 });
    }

    const res = await fetch(`${IMMICH_URL}/api/assets/${immichAssetId}/original`, {
      headers: {
        Accept: "video/*",
        "x-api-key": IMMICH_KEY,
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Video not found" }, { status: res.status });
    }

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "video/mp4",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message?.includes("exp")) {
      return NextResponse.json({ error: "Share link expired" }, { status: 410 });
    }
    console.error("GET /share/[token] error:", error);
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 400 });
  }
}
