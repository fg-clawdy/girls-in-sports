import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; assetId: string } }
) {
  try {
    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const asset = await prisma.asset.findUnique({
      where: { id: params.assetId },
    });

    if (!asset || asset.eventId !== params.id) {
      return NextResponse.json({ error: "Asset not found in this event" }, { status: 404 });
    }

    // Remove from Immich if linked
    if (asset.immichAssetId && event.immichAlbumId) {
      try {
        await fetch(`${IMMICH_URL}/api/albums/${event.immichAlbumId}/assets`, {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-api-key": IMMICH_KEY,
          },
          body: JSON.stringify({ ids: [asset.immichAssetId] }),
        });
      } catch (err) {
        console.warn("Failed to remove asset from Immich album:", err);
      }
    }

    // Delete GIS Asset record (cascade handles clip_scores, scene_segments, etc.)
    await prisma.asset.delete({
      where: { id: params.assetId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete asset error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete asset" },
      { status: 500 }
    );
  }
}
