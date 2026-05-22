import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { JobStatus } from "@prisma/client";

export async function GET() {
  try {
    const jobs = await prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        error: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        retryAfter: true,
        parentJobId: true,
        payload: true,
      },
    });

    const activeJobs = jobs.filter(
      (j) => j.status === JobStatus.QUEUED || j.status === JobStatus.RUNNING || j.status === JobStatus.RETRYING
    );

    // Event status for pipeline stages
    const events = await prisma.event.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        sport: true,
        status: true,
        createdAt: true,
      },
    });
    const campaigns = await prisma.campaign.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        eventId: true,
        name: true,
        status: true,
        createdAt: true,
      },
    });

    // Worker health check
    let workerHealthy = false;
    try {
      const res = await fetch("http://localhost:3011/health", { signal: AbortSignal.timeout(2000) });
      if (res.ok) workerHealthy = true;
    } catch {
      workerHealthy = false;
    }

    return NextResponse.json({
      jobs: activeJobs,
      recentJobs: jobs.slice(0, 50),
      events,
      campaigns,
      workerHealthy,
    });
  } catch (error) {
    console.error("GET /api/jobs/status error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
