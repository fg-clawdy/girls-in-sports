import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/feedback/composition/{id}
// Get all CompositionFeedback for a composition, plus aggregate stats
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const feedbacks = await prisma.compositionFeedback.findMany({
      where: { compositionId: params.id },
      orderBy: { createdAt: "desc" },
    });

    // Aggregate stats
    const total = feedbacks.length;
    const productionWorthyCount = feedbacks.filter((f) => f.productionWorthy).length;
    const avgRatings: Record<string, number> = {};

    if (total > 0) {
      const ratingKeys = [
        "assetSelection",
        "cutTiming",
        "videoLength",
        "transitions",
        "musicFit",
        "musicVolume",
        "aspectRatioHandling",
        "narrativeFlow",
        "textOverlays",
      ];
      for (const key of ratingKeys) {
        const values = feedbacks
          .map((f) => (f.ratings as Record<string, number> | null)?.[key])
          .filter((v): v is number => typeof v === "number");
        if (values.length > 0) {
          avgRatings[key] = parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1));
        }
      }
    }

    return NextResponse.json({
      success: true,
      feedbacks,
      stats: {
        total,
        productionWorthyCount,
        productionWorthyRate: total > 0 ? productionWorthyCount / total : 0,
        avgRatings,
      },
    });
  } catch (error) {
    console.error("CompositionFeedback fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500 }
    );
  }
}
