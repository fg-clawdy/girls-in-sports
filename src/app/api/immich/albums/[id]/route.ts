import { NextResponse } from "next/server";
import { getAlbum, isImmichConfigured } from "@/lib/immich";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!isImmichConfigured()) {
      return NextResponse.json(
        { error: "Immich not configured" },
        { status: 503 }
      );
    }

    const album = await getAlbum(params.id);
    return NextResponse.json({ album });
  } catch (error) {
    console.error("Immich album error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch album" },
      { status: 500 }
    );
  }
}
