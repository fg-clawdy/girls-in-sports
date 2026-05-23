import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncTagsToImmich } from "@/lib/immich";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { tags, action } = body;

    if (action === "add" && Array.isArray(tags)) {
      // Create AssetTag records
      await Promise.all(
        tags.map((tag: string) =>
          prisma.assetTag.upsert({
            where: { assetId_tag: { assetId: params.id, tag: tag.trim() } },
            create: { assetId: params.id, tag: tag.trim(), source: "USER_MANUAL" },
            update: {},
          })
        )
      );

      // Sync to Immich
      const asset = await prisma.asset.findUnique({
        where: { id: params.id },
        select: { immichAssetId: true, eventId: true, assetTags: { select: { tag: true } } },
      });

      if (asset?.immichAssetId) {
        const allTags = asset.assetTags.map((t) => t.tag);
        await syncTagsToImmich(asset.immichAssetId, allTags);
      }

      const addedThumbnail = Array.isArray(tags) && tags.some((t: string) => t.trim().toLowerCase() === "thumbnail");
      if (addedThumbnail && asset?.immichAssetId && asset.eventId) {
        try {
          const origin = new URL(request.url).origin;
          const thumbUrl = `${origin}/api/immich/thumbnail/${asset.immichAssetId}`;
          const thumbRes = await fetch(thumbUrl);
          if (thumbRes.ok) {
            const blob = await thumbRes.blob();
            const buffer = Buffer.from(await blob.arrayBuffer());
            const thumbnailsDir = path.join(process.cwd(), "public", "thumbnails");
            await mkdir(thumbnailsDir, { recursive: true });
            const thumbnailPath = path.join(thumbnailsDir, `${asset.eventId}.jpg`);
            await writeFile(thumbnailPath, buffer);
            await prisma.event.update({
              where: { id: asset.eventId },
              data: { thumbnailUrl: `/thumbnails/${asset.eventId}.jpg` },
            });
            console.log(`[US-015] Saved manual thumbnail for event ${asset.eventId} from asset ${params.id}`);
          }
        } catch (thumbErr) {
          console.warn("[US-015] Failed to save manual thumbnail:", thumbErr);
        }
      }

      return NextResponse.json({ synced: tags.length });
    }

    if (action === "remove" && Array.isArray(tags)) {
      await prisma.assetTag.deleteMany({
        where: { assetId: params.id, tag: { in: tags.map((t: string) => t.trim()) } },
      });

      // Re-sync remaining tags to Immich
      const asset = await prisma.asset.findUnique({
        where: { id: params.id },
        select: { immichAssetId: true, assetTags: { select: { tag: true } } },
      });

      if (asset?.immichAssetId) {
        const remainingTags = asset.assetTags.map((t) => t.tag);
        await syncTagsToImmich(asset.immichAssetId, remainingTags);
      }

      return NextResponse.json({ removed: tags.length });
    }

    return NextResponse.json({ error: "Invalid action. Use 'add' or 'remove'" }, { status: 400 });
  } catch (error) {
    console.error("POST /assets/[id]/tags error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
