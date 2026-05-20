import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: params.id },
      include: {
        event: { select: { id: true, name: true, sport: true, city: true, eventDate: true } },
        campaignClips: {
          include: { asset: { select: { id: true, immichAssetId: true, durationSeconds: true, widthPx: true, heightPx: true } } },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    // Look up final and proxy assets by scalar FK
    const [finalAsset, proxyAsset] = await Promise.all([
      campaign.finalAssetId
        ? prisma.asset.findUnique({
            where: { id: campaign.finalAssetId },
            select: { id: true, immichAssetId: true, filePath: true },
          })
        : null,
      campaign.proxyAssetId
        ? prisma.asset.findUnique({
            where: { id: campaign.proxyAssetId },
            select: { id: true, immichAssetId: true },
          })
        : null,
    ]);

    // Build video URLs from Immich via proxy routes
    const proxyVideoUrl = proxyAsset?.immichAssetId
      ? `/api/immich/assets/${proxyAsset.immichAssetId}`
      : null;
    const finalVideoUrl = finalAsset?.immichAssetId
      ? `/api/immich/assets/${finalAsset.immichAssetId}`
      : null;

    const clips = campaign.campaignClips.map((cc: any) => ({
      id: cc.id,
      assetId: cc.assetId,
      order: cc.order,
      startTimeMs: cc.startTimeMs,
      endTimeMs: cc.endTimeMs,
      narrativeLabel: cc.narrativeLabel,
      durationSeconds: cc.asset?.durationSeconds ||
        (cc.endTimeMs && cc.startTimeMs ? (cc.endTimeMs - cc.startTimeMs) / 1000 : 0),
      compositeScore: null,
      immichAssetId: cc.asset?.immichAssetId ?? null,
    }));

    return NextResponse.json({
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        targetFormat: campaign.targetFormat,
        brief: campaign.brief,
        energyPreset: campaign.energyPreset,
        musicUrl: campaign.musicUrl,
        musicPrompt: campaign.musicPrompt,
        userFeedbackJson: campaign.userFeedbackJson,
        scriptJson: campaign.scriptJson,
        event: campaign.event,
        proxyVideoUrl,
        finalVideoUrl,
      },
      clips,
    });
  } catch (error) {
    console.error("GET /campaigns/[id] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load campaign" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { userFeedbackJson, status } = body;

    const updateData: any = {};
    if (userFeedbackJson !== undefined) updateData.userFeedbackJson = userFeedbackJson;
    if (status !== undefined) updateData.status = status;

    const campaign = await prisma.campaign.update({
      where: { id: params.id },
      data: updateData,
    });

    return NextResponse.json({ campaign });
  } catch (error) {
    console.error("PATCH /campaigns/[id] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update campaign" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === "approve") {
      const campaign = await prisma.campaign.update({
        where: { id: params.id },
        data: { status: "APPROVED" },
      });

      // Enqueue RENDER_FINAL
      const { enqueueJob, JobType } = await import("@/lib/job-worker");
      await enqueueJob(JobType.RENDER_FINAL, {
        campaignId: params.id,
        eventId: campaign.eventId,
      });

      return NextResponse.json({ campaign });
    }

    if (action === "regenerate-music") {
      const campaign = await prisma.campaign.findUnique({
        where: { id: params.id },
      });
      if (!campaign) {
        return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
      }

      const { enqueueJob, JobType } = await import("@/lib/job-worker");
      await enqueueJob(JobType.GENERATE_MUSIC, {
        campaignId: params.id,
        eventId: campaign.eventId,
      });

      return NextResponse.json({ queued: true });
    }

    if (action === "start-over") {
      const campaign = await prisma.campaign.update({
        where: { id: params.id },
        data: { status: "SCRIPTED" },
      });
      return NextResponse.json({ campaign });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("POST /campaigns/[id] action error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
