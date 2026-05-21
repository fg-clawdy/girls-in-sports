import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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

    const tierThreshold: Record<string, number> = {
      AMATEUR: 0,
      INTERMEDIATE: 25,
      PROFESSIONAL: 50,
    };
    const threshold = tierThreshold[event.qualityTier] ?? 50;

    // Select the tier-appropriate score for filtering
    const tierScoreField = (() => {
      switch (event.qualityTier) {
        case "AMATEUR": return "amateurScore";
        case "INTERMEDIATE": return "intermediateScore";
        default: return "professionalScore";
      }
    })();

    const clips = await prisma.asset.findMany({
      where: {
        eventId: params.id,
        OR: [
          { type: "CLIP" },
          { type: "SOURCE_VIDEO", status: "SCORED" },
        ],
        status: "SCORED",
        clipScore: {
          [tierScoreField]: { gte: threshold },
        },
      },
      include: {
        clipScore: true,
        assetTags: true,
      },
      orderBy: {
        clipScore: {
          [tierScoreField]: "desc",
        },
      },
    });

    return NextResponse.json({ event, clips });
  } catch (error) {
    console.error("GET /events/[id]/clips error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch clips" },
      { status: 500 }
    );
  }
}
