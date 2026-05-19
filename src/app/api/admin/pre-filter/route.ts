import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { runPreFilter, isPreFiltered } from "@/lib/pre-filter-service";

/**
 * POST /api/admin/pre-filter
 *
 * Run the lightweight local pre-filter on an image asset.
 * Body: { assetId: string, eventId: string, localImagePath: string }
 *
 * Returns the pre-filter scores and whether the image passed the gate.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { assetId, eventId, localImagePath } = body;

    if (!assetId || !eventId || !localImagePath) {
      return NextResponse.json(
        { error: "assetId, eventId, and localImagePath are required" },
        { status: 400 }
      );
    }

    // Check if already processed
    const alreadyFiltered = await isPreFiltered(assetId);
    if (alreadyFiltered) {
      return NextResponse.json({
        success: true,
        alreadyProcessed: true,
        message: "Asset already pre-filtered",
      });
    }

    // Verify file exists
    try {
      await fs.access(localImagePath);
    } catch {
      return NextResponse.json(
        { error: "Image file not found at specified path" },
        { status: 404 }
      );
    }

    const result = await runPreFilter(assetId, eventId, localImagePath);

    return NextResponse.json({
      success: true,
      alreadyProcessed: false,
      scores: {
        brightnessScore: result.brightnessScore,
        blurScore: result.blurScore,
        faceScore: result.faceScore,
        actionScore: result.actionScore,
        compositionScore: result.compositionScore,
        overallScore: result.overallScore,
      },
      passedFilter: result.passedFilter,
      features: result.featuresJson,
    });
  } catch (error) {
    console.error("Pre-filter error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Pre-filter analysis failed",
      },
      { status: 500 }
    );
  }
}
