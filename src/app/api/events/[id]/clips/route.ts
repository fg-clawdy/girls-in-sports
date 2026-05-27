import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { TIER_FORMULAS, computeTieredScore } from "@/lib/tier-formulas";

// Force dynamic so that when a brand-new event is created and the user
// immediately navigates to /events/[id], the first load (and any hard refresh)
// sees the real data instead of a cached 404 or empty payload.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const tier = event.qualityTier ?? "PROFESSIONAL";

    const clips = await prisma.asset.findMany({
      where: {
        eventId: params.id,
        OR: [
          { type: "CLIP" },
          { type: "SOURCE_VIDEO", status: "SCORED" },
        ],
        status: "SCORED",
      },
      select: {
        id: true,
        immichAssetId: true,
        durationSeconds: true,
        type: true,
        status: true,
        parentAssetId: true,
        startTimeMs: true,
        endTimeMs: true,
        heightPx: true,
        widthPx: true,
        clipScore: true,
        assetTags: true,
      },
    });

    // Enrich each clip with tiered combined score and pass/fail
    const enrichedClips = clips.map((clip) => {
      const { combined, passes } = computeTieredScore(
        clip.clipScore?.momentScore,
        clip.clipScore?.productionScore,
        tier
      );
      return {
        ...clip,
        tieredScore: combined,
        tieredPasses: passes,
      };
    });

    // Sort all clips by tieredScore desc. We no longer filter out below-threshold
    // clips on the server; the UI shows them with a warning and lets the user
    // decide whether to accept them anyway or adjust the quality tier.
    const sorted = enrichedClips.sort((a, b) => b.tieredScore - a.tieredScore);

    return NextResponse.json({ event, clips: sorted, tier, formulas: TIER_FORMULAS });
  } catch (error) {
    console.error("GET /events/[id]/clips error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch clips" },
      { status: 500 }
    );
  }
}
