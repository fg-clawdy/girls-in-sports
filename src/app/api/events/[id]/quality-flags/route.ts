// US-014: Enhanced quality-flags endpoint for user-facing failure messages.
// Returns both legacy per-asset flags (AssetQualityFlag) and aggregated
// Job-level failures (error + qualityFlags JSON) so the event page can show
// messages like "3 clips failed vision analysis – using motion heuristics only".
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const eventId = params.id;

    // Legacy per-asset quality flags (still written by some older paths)
    const legacyFlags = await prisma.assetQualityFlag.findMany({
      where: { eventId },
      orderBy: { createdAt: "desc" },
    });

    // US-014: Jobs for this event (eventId lives inside payload JSON)
    // We fetch a reasonable window; aggregation is cheap for real events.
    const jobs = await prisma.job.findMany({
      where: {
        payload: {
          path: ["eventId"],
          equals: eventId,
        },
      },
      select: {
        id: true,
        type: true,
        status: true,
        error: true,
        qualityFlags: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    // Aggregate failures by stage from the qualityFlags we write in every handler
    const byStage: Record<string, number> = {};
    const sampleErrors: Array<{
      jobId: string;
      stage: string;
      error: string;
      jobType: string;
      status: string;
    }> = [];

    for (const job of jobs) {
      const qf = (job.qualityFlags as Record<string, any>) || {};
      const hasTopLevelError = !!job.error;

      if (hasTopLevelError) {
        // Jobs that only recorded via recordJobError (top-level error)
        const stage = "job-level";
        byStage[stage] = (byStage[stage] || 0) + 1;
        if (sampleErrors.length < 10) {
          sampleErrors.push({
            jobId: job.id,
            stage,
            error: job.error!,
            jobType: job.type,
            status: job.status,
          });
        }
      }

      // Per-stage structured failures we write (e.g. "score-clip", "render-final", "vision", etc.)
      for (const [stage, flags] of Object.entries(qf)) {
        const f = flags as any;
        if (f && (f.failed === true || f.error)) {
          byStage[stage] = (byStage[stage] || 0) + 1;
          if (sampleErrors.length < 10) {
            sampleErrors.push({
              jobId: job.id,
              stage,
              error: f.error || job.error || "unknown failure",
              jobType: job.type,
              status: job.status,
            });
          }
        }
      }
    }

    const totalFailedJobs = jobs.filter((j) => j.error || Object.keys((j.qualityFlags as any) || {}).length > 0).length;

    const summary = {
      totalFailedJobs,
      byStage,
      hasFallbacks: jobs.some((j) => {
        const qf = (j.qualityFlags as any) || {};
        return Object.values(qf).some((f: any) => f && f.fallbackUsed);
      }),
      sampleRecentFailures: sampleErrors.slice(0, 10),
    };

    return NextResponse.json({
      summary,
      recentJobFailures: jobs.map((j) => ({
        jobId: j.id,
        type: j.type,
        status: j.status,
        error: j.error,
        qualityFlags: j.qualityFlags,
        createdAt: j.createdAt,
      })),
      legacyAssetFlags: legacyFlags,
    });
  } catch (error) {
    console.error("Quality flags fetch error:", error);
    return NextResponse.json({
      summary: { totalFailedJobs: 0, byStage: {}, hasFallbacks: false, sampleRecentFailures: [] },
      recentJobFailures: [],
      legacyAssetFlags: [],
    });
  }
}
