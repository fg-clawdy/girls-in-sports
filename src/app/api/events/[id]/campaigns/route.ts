import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob, JobType } from "@/lib/job-worker";
import { estimateDirectScriptCost, checkAndReserveBudget } from "@/lib/cost-estimator";

// Force dynamic so campaigns for a brand-new event appear immediately
// after create + navigation or hard refresh.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { eventId: params.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        status: true,
        targetFormat: true,
        energyPreset: true,
        createdAt: true,
        proxyAssetId: true,
        finalAssetId: true,
      },
    });
    return NextResponse.json({ campaigns });
  } catch (error) {
    console.error("GET /events/[id]/campaigns error:", error);
    return NextResponse.json({ error: "Failed to load campaigns" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { brief, targetFormat, energyPreset, selectedAssetIds, mustIncludeAssetIds, musicModel } = body;

    if (!targetFormat) {
      return NextResponse.json({ error: "targetFormat is required" }, { status: 400 });
    }
    if (!selectedAssetIds || selectedAssetIds.length < 3) {
      return NextResponse.json({ error: "At least 3 clips must be accepted" }, { status: 400 });
    }

    // S1-06: validate music model
    const VALID_MUSIC_MODELS = ["minimax-music-v26", "elevenlabs-music", "minimax-music-v2", "minimax-music-v25"];
    const resolvedMusicModel = VALID_MUSIC_MODELS.includes(musicModel) ? musicModel : "minimax-music-v26";

    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const clipCount = selectedAssetIds.length;
    const hasIntent = !!(brief && brief.trim());
    const est = estimateDirectScriptCost(clipCount, hasIntent);
    const budgetCheck = await checkAndReserveBudget(params.id, est.estimatedDIEM);
    if (!budgetCheck.allowed) {
      return NextResponse.json({ error: budgetCheck.reason || "Budget exceeded" }, { status: 402 });
    }

    // Fetch selected assets (with parent linkage) so we can preserve precise child-scene timing on CampaignClip
    const selectedAssets = await prisma.asset.findMany({
      where: { id: { in: selectedAssetIds } },
      select: {
        id: true,
        immichAssetId: true,
        parentAssetId: true,
        startTimeMs: true,
        endTimeMs: true,
        durationSeconds: true,
      },
    });
    const parentIds = Array.from(new Set(selectedAssets.map((a) => a.parentAssetId).filter((id): id is string => !!id)));
    const parents = parentIds.length
      ? await prisma.asset.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, immichAssetId: true },
        })
      : [];
    const parentImmichById = new Map(parents.map((p) => [p.id, p.immichAssetId]));
    const assetMeta = new Map(selectedAssets.map((a) => [a.id, a]));

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
        musicModelPreference: resolvedMusicModel,
      },
    });

    // Create CampaignClip rows — for child CLIP scenes, store the precise timing window
    // (absolute in parent video for legacy virtual scenes; 0..duration for real pre-cut children)
    await prisma.campaignClip.createMany({
      data: selectedAssetIds.map((assetId: string, idx: number) => {
        const a = assetMeta.get(assetId);
        let st: number | null = null;
        let et: number | null = null;
        if (a && a.startTimeMs != null && a.endTimeMs != null) {
          const parentImmich = a.parentAssetId ? parentImmichById.get(a.parentAssetId) : null;
          if (a.parentAssetId && parentImmich && a.immichAssetId === parentImmich) {
            // legacy virtual scene: times are absolute within the shared parent source video
            st = a.startTimeMs;
            et = a.endTimeMs;
          } else {
            // real child CLIP (own immich id): 0-based within this asset's video
            st = 0;
            et = Math.round((a.durationSeconds || 0) * 1000);
          }
        }
        return {
          campaignId: campaign.id,
          assetId,
          order: idx,
          accepted: true,
          mustInclude: (mustIncludeAssetIds ?? []).includes(assetId),
          startTimeMs: st,
          endTimeMs: et,
        };
      }),
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
