import { NextResponse } from "next/server";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

function isImmichConfigured(): boolean {
  return Boolean(IMMICH_URL && IMMICH_KEY);
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!isImmichConfigured()) {
      return NextResponse.json({ error: "Immich not configured" }, { status: 503 });
    }

    // Forward range headers for video streaming
    const headers: Record<string, string> = {
      Accept: "image/*,video/*",
      "x-api-key": IMMICH_KEY,
    };

    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
      headers["Range"] = rangeHeader;
    }

    const res = await fetch(`${IMMICH_URL}/api/assets/${params.id}/original`, {
      headers,
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Asset fetch failed" },
        { status: res.status }
      );
    }

    const blob = await res.blob();
    const responseHeaders = new Headers();

    // Forward content type
    const contentType = res.headers.get("Content-Type");
    if (contentType) responseHeaders.set("Content-Type", contentType);

    // Forward content range for streaming
    const contentRange = res.headers.get("Content-Range");
    if (contentRange) responseHeaders.set("Content-Range", contentRange);

    // Forward accept-ranges
    const acceptRanges = res.headers.get("Accept-Ranges");
    if (acceptRanges) responseHeaders.set("Accept-Ranges", acceptRanges);

    responseHeaders.set("Cache-Control", "public, max-age=86400");

    return new NextResponse(blob, {
      status: res.status, // may be 206 for partial content
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Asset proxy error:", error);
    return NextResponse.json({ error: "Failed to fetch asset" }, { status: 500 });
  }
}
