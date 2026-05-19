import { NextResponse } from "next/server";
import { generateWeeklyCritique } from "@/lib/weekly-critique-service";

/**
 * POST /api/admin/weekly-critique
 *
 * Trigger weekly critique generation manually or via cron.
 * Analyzes the previous week's CompositionFeedback and generates an LLM-powered report.
 *
 * Optional body: { weekStart?: "YYYY-MM-DD" } to analyze a specific week.
 */
export async function POST(request: Request) {
  try {
    let weekStart: Date | undefined;

    try {
      const body = await request.json();
      if (body.weekStart) {
        weekStart = new Date(body.weekStart);
        if (isNaN(weekStart.getTime())) {
          weekStart = undefined;
        }
      }
    } catch {
      // No body or invalid JSON — use default (previous week)
    }

    const result = await generateWeeklyCritique(weekStart);

    return NextResponse.json({
      success: true,
      critique: {
        id: result.id,
        weekStart: result.weekStart.toISOString(),
        weekEnd: result.weekEnd.toISOString(),
        totalFeedback: result.totalFeedback,
        avgProductionWorthy: result.avgProductionWorthy,
        avgRatings: result.avgRatings,
        topIssues: result.topIssues,
        topLiked: result.topLiked,
        topChanges: result.topChanges,
        critiqueText: result.critiqueText,
        actionItems: result.actionItems,
        modelUsed: result.modelUsed,
        costDIEM: result.costDIEM,
      },
    });
  } catch (error) {
    console.error("Weekly critique generation error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Weekly critique generation failed",
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/weekly-critique
 *
 * List existing weekly critiques, most recent first.
 */
export async function GET() {
  try {
    const { prisma } = await import("@/lib/prisma");
    const critiques = await prisma.weeklyCritique.findMany({
      orderBy: { weekStart: "desc" },
      take: 12, // Last 12 weeks
    });

    return NextResponse.json({
      success: true,
      count: critiques.length,
      critiques: critiques.map((c) => ({
        id: c.id,
        weekStart: c.weekStart.toISOString(),
        weekEnd: c.weekEnd.toISOString(),
        totalFeedback: c.totalFeedback,
        avgProductionWorthy: c.avgProductionWorthy,
        avgRatings: c.avgRatings,
        topIssues: c.topIssues,
        topLiked: c.topLiked,
        topChanges: c.topChanges,
        critiqueText: c.critiqueText.substring(0, 500), // truncated for list view
        actionItems: c.actionItems,
        modelUsed: c.modelUsed,
        costDIEM: c.costDIEM,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Weekly critique list error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list weekly critiques",
      },
      { status: 500 }
    );
  }
}
