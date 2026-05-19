import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/feedback/composition
// Save a CompositionFeedback record
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      compositionId,
      productionWorthy,
      ratings,
      userIntent,
      generatedScript,
      musicPrompt,
      musicModel,
      selectedAssetIds,
      outputDuration,
      freeformNotes,
      likedMost,
      wouldChange,
      estimatedImpressions,
      costDIEM,
    } = body;

    if (!compositionId || productionWorthy === undefined) {
      return NextResponse.json(
        { error: "compositionId and productionWorthy are required" },
        { status: 400 }
      );
    }

    const feedback = await prisma.compositionFeedback.create({
      data: {
        compositionId,
        productionWorthy: Boolean(productionWorthy),
        ratings: ratings || {},
        userIntent: userIntent || null,
        generatedScript: generatedScript || null,
        musicPrompt: musicPrompt || null,
        musicModel: musicModel || null,
        selectedAssetIds: selectedAssetIds || [],
        outputDuration: outputDuration || null,
        freeformNotes: freeformNotes || null,
        likedMost: likedMost || null,
        wouldChange: wouldChange || null,
        estimatedImpressions: estimatedImpressions || null,
        costDIEM: costDIEM || null,
      },
    });

    return NextResponse.json({ success: true, feedback });
  } catch (error) {
    console.error("CompositionFeedback creation error:", error);
    return NextResponse.json(
      { error: "Failed to save feedback" },
      { status: 500 }
    );
  }
}
