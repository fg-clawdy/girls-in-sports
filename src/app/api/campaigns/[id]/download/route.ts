import { NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    if (!IMMICH_URL || !IMMICH_KEY) {
      return NextResponse.json({ error: "Immich not configured" }, { status: 503 });
    }

    const { prisma } = await import("@/lib/prisma");

    const campaign = await prisma.campaign.findUnique({
      where: { id: params.id },
      select: { name: true, finalAssetId: true },
    });

    if (!campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    const finalAsset = campaign.finalAssetId
      ? await prisma.asset.findUnique({
          where: { id: campaign.finalAssetId },
          select: { immichAssetId: true, filePath: true },
        })
      : null;

    // Prefer local filePath for direct download if it exists
    if (finalAsset?.filePath) {
      try {
        const stats = statSync(finalAsset.filePath);
        const fileName = `${campaign.name.replace(/[^a-zA-Z0-9]/g, "_")}_final.mp4`;
        const stream = createReadStream(finalAsset.filePath);

        return new NextResponse(stream as any, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(stats.size),
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch {
        // Fallback to Immich proxy
      }
    }

    // Fallback: proxy from Immich original endpoint
    if (finalAsset?.immichAssetId) {
      const res = await fetch(`${IMMICH_URL}/api/assets/${finalAsset.immichAssetId}/original`, {
        headers: {
          Accept: "video/*",
          "x-api-key": IMMICH_KEY,
        },
      });

      if (!res.ok) {
        return NextResponse.json({ error: "Failed to fetch video from Immich" }, { status: res.status });
      }

      const fileName = `${campaign.name.replace(/[^a-zA-Z0-9]/g, "_")}_final.mp4`;
      const blob = await res.blob();

      return new NextResponse(blob, {
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "video/mp4",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    return NextResponse.json({ error: "Final video not available" }, { status: 404 });
  } catch (error) {
    console.error("GET /campaigns/[id]/download error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to download" },
      { status: 500 }
    );
  }
}
