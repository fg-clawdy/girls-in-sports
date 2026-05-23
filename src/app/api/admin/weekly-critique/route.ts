import { NextResponse } from "next/server";
import { generateWeeklyCritique } from "@/lib/weekly-critique-service";
import { requireAdmin } from "@/lib/auth";

/**
 * POST /api/admin/weekly-critique
 *
 * Trigger weekly critique generation manually or via cron.
 * Analyzes the previous week's CompositionFeedback and generates an LLM-powered report.
 *
 * Optional body: { weekStart?: "YYYY-MM-DD" } to analyze a specific week.
 */
export async function POST(request: Request) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck instanceof NextResponse) return adminCheck;

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
        suggestedChanges: result.suggestedChanges || [],
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
export async function GET(request: Request) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const url = new URL(request.url);
    const requestedId = url.searchParams.get("id");

    const { prisma } = await import("@/lib/prisma");

    if (requestedId) {
      // Specific full weekly critique (for US-007 equivalent)
      const critique = await prisma.weeklyCritique.findUnique({ where: { id: requestedId } });
      return NextResponse.json({
        success: true,
        critique: critique
          ? {
              id: critique.id,
              weekStart: critique.weekStart.toISOString(),
              weekEnd: critique.weekEnd.toISOString(),
              totalFeedback: critique.totalFeedback,
              avgProductionWorthy: critique.avgProductionWorthy,
              avgRatings: critique.avgRatings,
              topIssues: critique.topIssues,
              topLiked: critique.topLiked,
              topChanges: critique.topChanges,
              critiqueText: critique.critiqueText,
              actionItems: critique.actionItems,
              suggestedChanges: (critique.suggestedChanges as any) || [],
              appliedSuggestions: (critique as any).appliedSuggestions || {}, // future-proof
              modelUsed: critique.modelUsed,
              costDIEM: critique.costDIEM,
              createdAt: critique.createdAt.toISOString(),
            }
          : null,
      });
    }

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
        suggestedChanges: (c.suggestedChanges as any) || [],
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
