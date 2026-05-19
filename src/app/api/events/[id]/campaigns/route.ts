import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob, JobType } from "@/lib/job-worker";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { brief, targetFormat, energyPreset, selectedAssetIds, mustIncludeAssetIds } = body;

    if (!targetFormat) {
      return NextResponse.json({ error: "targetFormat is required" }, { status: 400 });
    }
    if (!selectedAssetIds || selectedAssetIds.length < 3) {
      return NextResponse.json({ error: "At least 3 clips must be accepted" }, { status: 400 });
    }

    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Create campaign
    const campaign = await prisma.campaign.create({
      data: {
        eventId: params.id,
        name: `${event.name} — ${targetFormat}`,
        targetFormat: targetFormat as any,
        energyPreset: (energyPreset as any) ?? "HYPE",
        brief: brief ?? null,
        selectedAssetIds: selectedAssetIds as string[],
        status: "DIRECTING",
      },
    });

    // Create CampaignClip rows for each selected asset
    await prisma.campaignClip.createMany({
      data: selectedAssetIds.map((assetId: string, idx: number) => ({
        campaignId: campaign.id,
        assetId,
        order: idx,
        accepted: true,
        mustInclude: (mustIncludeAssetIds ?? []).includes(assetId),
      })),
    });

    // Enqueue DIRECT_SCRIPT job
    await enqueueJob(
      JobType.DIRECT_SCRIPT,
      {
        campaignId: campaign.id,
        eventId: params.id,
        selectedAssetIds,
        mustIncludeAssetIds: mustIncludeAssetIds ?? [],
      }
    );

    return NextResponse.json({ campaign });
  } catch (error) {
    console.error("POST /events/[id]/campaigns error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create campaign" },
      { status: 500 }
    );
  }
}
