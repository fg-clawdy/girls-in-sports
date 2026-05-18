import { NextResponse } from "next/server";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

function isImmichConfigured(): boolean {
  return Boolean(IMMICH_URL && IMMICH_KEY);
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!isImmichConfigured()) {
      return NextResponse.json({ error: "Immich not configured" }, { status: 503 });
    }

    const res = await fetch(`${IMMICH_URL}/api/assets/${params.id}/thumbnail?size=thumbnail`, {
      headers: {
        Accept: "image/*",
        "x-api-key": IMMICH_KEY,
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Thumbnail fetch failed" },
        { status: res.status }
      );
    }

    const blob = await res.blob();

    return new NextResponse(blob, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("Thumbnail proxy error:", error);
    return NextResponse.json({ error: "Failed to fetch thumbnail" }, { status: 500 });
  }
}
