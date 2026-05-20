import { NextResponse } from "next/server";
import { runFeedbackAnalysis } from "@/lib/feedback-analysis";
import { prisma } from "@/lib/prisma";

function isAdminAuth(request: Request): boolean {
  const url = new URL(request.url);
  const adminToken = url.searchParams.get("token") || request.headers.get("x-admin-token");
  return adminToken === process.env.ADMIN_SECRET || adminToken === "gis-local-dev";
}

export async function POST(request: Request) {
  try {
    if (!isAdminAuth(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
  try {
    if (!isAdminAuth(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const analysis = await prisma.feedbackAnalysisReport.findFirst({
      orderBy: { generatedAt: "desc" },
    });

    return NextResponse.json({
      analysis: analysis
        ? {
            id: analysis.id,
            generatedAt: analysis.generatedAt.toISOString(),
            recommendations: analysis.recommendations,
            feedbackCount: analysis.feedbackCount,
            appliedAt: analysis.appliedAt?.toISOString() || null,
          }
        : null,
    });
  } catch (error) {
    console.error("GET /admin/feedback-report/analysis error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
