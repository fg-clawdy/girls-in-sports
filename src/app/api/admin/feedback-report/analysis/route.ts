import { NextResponse } from "next/server";
import { runFeedbackAnalysis } from "@/lib/feedback-analysis";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export async function POST(request: Request) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const result = await runFeedbackAnalysis();
    return NextResponse.json({ analysis: result });
  } catch (error) {
    console.error("POST /admin/feedback-report/analysis error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const url = new URL(request.url);
    const requestedId = url.searchParams.get("id");

    let analysis: any = null;
    let recentReports: any[] = [];

    if (requestedId) {
      // Specific full report query (for US-007 queryable reports)
      analysis = await prisma.feedbackAnalysisReport.findUnique({
        where: { id: requestedId },
      });
      recentReports = [];
    } else {
      const [latestAnalysis, historyReports] = await Promise.all([
        prisma.feedbackAnalysisReport.findFirst({ orderBy: { generatedAt: "desc" } }),
        prisma.feedbackAnalysisReport.findMany({
          orderBy: { generatedAt: "desc" },
          take: 12,
          select: {
            id: true,
            generatedAt: true,
            feedbackCount: true,
            appliedAt: true,
            recommendations: true,
            reportJson: true,
          },
        }),
      ]);
      analysis = latestAnalysis;
      recentReports = historyReports;
    }

    const latest = analysis
      ? {
          id: analysis.id,
          generatedAt: analysis.generatedAt.toISOString(),
          recommendations: analysis.recommendations,
          feedbackCount: analysis.feedbackCount,
          appliedAt: analysis.appliedAt?.toISOString() || null,
          suggestedChanges: (analysis.reportJson as any)?.suggestedChanges || [],
          appliedSuggestions: (analysis.reportJson as any)?.appliedSuggestions || {},
          appliedNotes: (analysis.reportJson as any)?.appliedNotes || null,
        }
      : null;

    const history = (recentReports || []).map((r) => ({
      id: r.id,
      generatedAt: r.generatedAt.toISOString(),
      feedbackCount: r.feedbackCount,
      appliedAt: r.appliedAt?.toISOString() || null,
      suggestedChangesCount: ((r.reportJson as any)?.suggestedChanges?.length) || 0,
      hasRecommendations: !!r.recommendations,
    }));

    return NextResponse.json({
      analysis: latest,
      history,
      ...(requestedId ? { fullReport: latest } : {}),
    });
  } catch (error) {
    console.error("GET /admin/feedback-report/analysis error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
