import { NextResponse } from "next/server";
import { getAssetThumbnailUrl, isImmichConfigured } from "@/lib/immich";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!isImmichConfigured()) {
      return NextResponse.json({ error: "Immich not configured" }, { status: 503 });
    }

    const url = getAssetThumbnailUrl(params.id);

    const res = await fetch(url, {
      headers: { Accept: "image/*" },
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
