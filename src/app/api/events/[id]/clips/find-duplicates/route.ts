import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeTieredScore } from "@/lib/tier-formulas";
import { findDuplicateClips } from "@/lib/clip-duplicate-detector";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const event = await prisma.event.findUnique({ where: { id: params.id } });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const tier = event.qualityTier ?? "PROFESSIONAL";

    const clips = await prisma.asset.findMany({
      where: {
        eventId: params.id,
        type: "CLIP",
        status: "SCORED",
      },
      select: {
        id: true,
        parentAssetId: true,
        startTimeMs: true,
        endTimeMs: true,
        durationSeconds: true,
        immichAssetId: true,
        clipScore: {
          select: {
            momentScore: true,
            productionScore: true,
            clipType: true,
          },
        },
        parentAsset: { select: { immichAssetId: true } },
      },
    });

    const enriched = clips.map((clip) => {
      const { combined } = computeTieredScore(
        clip.clipScore?.momentScore,
        clip.clipScore?.productionScore,
        tier
      );
      return {
        id: clip.id,
        parentAssetId: clip.parentAssetId,
        startTimeMs: clip.startTimeMs,
        endTimeMs: clip.endTimeMs,
        tieredScore: combined,
        clipScore: { clipType: (clip.clipScore?.clipType as string | null) ?? null },
        durationSeconds: clip.durationSeconds,
        immichAssetId: clip.immichAssetId,
        parentImmichAssetId: clip.parentAsset ? (clip.parentAsset.immichAssetId ?? null) : null,
      };
    });

    const allGroups = findDuplicateClips(enriched);

    const exactDuplicates = allGroups.filter((g) => g.type === "EXACT_DUPLICATE");
    const overlappingSegments = allGroups.filter((g) => g.type === "OVERLAPPING_SEGMENT");

    return NextResponse.json({ exactDuplicates, overlappingSegments });
  } catch (error) {
    console.error("POST /events/[id]/clips/find-duplicates error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to find duplicates" },
      { status: 500 }
    );
  }
}
