import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob, JobType } from "@/lib/job-worker";
import { getEnv } from "@/lib/env";

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

    // US-004 auto-trigger
    try {
      const threshold = getEnv().FEEDBACK_ANALYSIS_THRESHOLD;
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentCount = await prisma.compositionFeedback.count({
        where: { createdAt: { gte: since } },
      });
      if (recentCount >= threshold) {
        const lastReport = await prisma.feedbackAnalysisReport.findFirst({
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true },
        });
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (!lastReport || lastReport.generatedAt < oneHourAgo) {
          await enqueueJob(JobType.FEEDBACK_ANALYSIS, { trigger: "composition-feedback", count: recentCount });
        }
      }
    } catch (e) {
      // non-fatal
    }

    return NextResponse.json({ success: true, feedback });
  } catch (error) {
    console.error("CompositionFeedback creation error:", error);
    return NextResponse.json(
      { error: "Failed to save feedback" },
      { status: 500 }
    );
  }
}
