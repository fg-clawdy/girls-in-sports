import { NextResponse } from "next/server";
import { enqueueJob, JobType } from "@/lib/job-worker";
import { getEnv } from "@/lib/env";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const {
      productionWorthy,
      overallRating,
      wouldChange,
      clipSentiments,
      musicSatisfied,
    } = body;

    if (typeof productionWorthy !== "boolean" || typeof overallRating !== "number") {
      return NextResponse.json(
        { error: "productionWorthy (boolean) and overallRating (number) are required" },
        { status: 400 }
      );
    }

    if (overallRating < 1 || overallRating > 5) {
      return NextResponse.json({ error: "overallRating must be 1-5" }, { status: 400 });
    }

    const { prisma } = await import("@/lib/prisma");

    // Store in standalone CampaignFeedback table
    const feedback = await prisma.campaignFeedback.create({
      data: {
        campaignId: params.id,
        productionWorthy,
        overallRating,
        wouldChange: wouldChange || null,
        clipSentiments: clipSentiments || null,
        musicSatisfied: musicSatisfied ?? null,
      },
    });

    // Also merge into Campaign.userFeedbackJson for quick access
    const existing = await prisma.campaign.findUnique({
      where: { id: params.id },
      select: { userFeedbackJson: true },
    });

    const existingJson = (existing?.userFeedbackJson as any) || {};
    await prisma.campaign.update({
      where: { id: params.id },
      data: {
        userFeedbackJson: {
          ...existingJson,
          postRender: {
            productionWorthy,
            overallRating,
            wouldChange: wouldChange || null,
            clipSentiments: clipSentiments || null,
            musicSatisfied: musicSatisfied ?? null,
            submittedAt: new Date().toISOString(),
          },
        },
      },
    });

    // US-004 auto-trigger (per-event or global threshold)
    try {
      const threshold = getEnv().FEEDBACK_ANALYSIS_THRESHOLD;
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentCount = await prisma.campaignFeedback.count({
        where: { createdAt: { gte: since } },
      });
      if (recentCount >= threshold) {
        const lastReport = await prisma.feedbackAnalysisReport.findFirst({
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true },
        });
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (!lastReport || lastReport.generatedAt < oneHourAgo) {
          await enqueueJob(JobType.FEEDBACK_ANALYSIS, { trigger: "campaign-feedback", campaignId: params.id, count: recentCount });
        }
      }
    } catch (e) {
      // non-fatal, analysis can be triggered manually
    }

    return NextResponse.json({ feedback });
  } catch (error) {
    console.error("POST /campaigns/[id]/feedback error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save feedback" },
      { status: 500 }
    );
  }
}
