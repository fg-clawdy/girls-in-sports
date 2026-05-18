import { NextResponse } from "next/server";
import { getAssetOriginalUrl, isImmichConfigured } from "@/lib/immich";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!isImmichConfigured()) {
      return NextResponse.json({ error: "Immich not configured" }, { status: 503 });
    }

    const url = getAssetOriginalUrl(params.id);

    const res = await fetch(url, {
      headers: {
        Accept: "image/*,video/*",
        "x-api-key": process.env.IMMICH_API_KEY || "",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Asset fetch failed" },
        { status: res.status }
      );
    }

    const blob = await res.blob();

    return new NextResponse(blob, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("Asset proxy error:", error);
    return NextResponse.json({ error: "Failed to fetch asset" }, { status: 500 });
  }
}
