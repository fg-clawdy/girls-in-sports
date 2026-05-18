import { NextResponse } from "next/server";
import {
  getAllAlbums,
  getAlbum,
  isImmichConfigured,
} from "@/lib/immich";

export async function GET() {
  try {
    if (!isImmichConfigured()) {
      return NextResponse.json(
        { error: "Immich not configured. Set IMMICH_API_URL and IMMICH_API_KEY in .env" },
        { status: 503 }
      );
    }

    const albums = await getAllAlbums();
    return NextResponse.json({ albums });
  } catch (error) {
    console.error("Immich albums error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch albums" },
      { status: 500 }
    );
  }
}
