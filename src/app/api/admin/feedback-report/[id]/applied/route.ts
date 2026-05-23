import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const { id } = params;
    const body = await request.json().catch(() => ({}));
    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    const suggestionFile = typeof body.file === "string" ? body.file.trim() : null; // for individual suggestion

    const existing = await prisma.feedbackAnalysisReport.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    const reportJson = { ...(existing.reportJson as any) };
    if (notes) {
      reportJson.appliedNotes = notes;
    }

    const now = new Date().toISOString();

    if (suggestionFile) {
      // Mark individual suggestion as applied (US-007)
      if (!reportJson.appliedSuggestions) reportJson.appliedSuggestions = {};
      reportJson.appliedSuggestions[suggestionFile] = now;
    } else {
      // Mark whole report
      // (existing behavior)
    }

    const updated = await prisma.feedbackAnalysisReport.update({
      where: { id },
      data: {
        appliedAt: new Date(),
        reportJson,
      },
    });

    return NextResponse.json({
      success: true,
      id: updated.id,
      appliedAt: updated.appliedAt?.toISOString() || null,
      appliedNotes: (updated.reportJson as any)?.appliedNotes || null,
      appliedSuggestions: (updated.reportJson as any)?.appliedSuggestions || {},
      ...(suggestionFile ? { markedSuggestion: suggestionFile } : {}),
    });
  } catch (error) {
    console.error("PATCH /admin/feedback-report/[id]/applied error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to mark applied" },
      { status: 500 }
    );
  }
}
