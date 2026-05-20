import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncTagsToImmich } from "@/lib/immich";

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
        select: { immichAssetId: true, assetTags: { select: { tag: true } } },
      });

      if (asset?.immichAssetId) {
        const allTags = asset.assetTags.map((t) => t.tag);
        await syncTagsToImmich(asset.immichAssetId, allTags);
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
