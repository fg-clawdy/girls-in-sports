import { NextResponse } from "next/server";
import { analyzeMediaWithVision, fallbackRanking, isVisionConfigured } from "@/lib/vision";
import { getAssetPreviewUrl } from "@/lib/immich";

export async function POST(request: Request) {
  let assetIds: string[] = [];

  try {
    const body = await request.json();
    assetIds = body.assetIds || [];
    const eventId = body.eventId;

    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      return NextResponse.json(
        { error: "assetIds array required" },
        { status: 400 }
      );
    }

    // Prepare URLs for all assets
    const assetUrls = assetIds.map((id: string) => ({
      assetId: id,
      url: getAssetPreviewUrl(id),
    }));

    let result;

    if (isVisionConfigured()) {
      result = await analyzeMediaWithVision(assetUrls, {
        maxImages: 8, // Reasonable limit for token budgets
      });
    } else {
      // Fallback: return all assets in original order
      result = fallbackRanking(assetIds);
    }

    return NextResponse.json({
      success: true,
      scores: result.scores,
      topIds: result.topIds,
      modelUsed: result.modelUsed,
      visionConfigured: isVisionConfigured(),
      eventId: eventId || null,
    });
  } catch (error) {
    console.error("Vision analysis error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Analysis failed",
        scores: [],
        topIds: assetIds.slice(0, 10),
      },
      { status: 500 }
    );
  }
}
