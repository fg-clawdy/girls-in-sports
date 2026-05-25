import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Force dynamic so jobs for a freshly created event are visible immediately
// on navigation or hard refresh of the event detail page.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const eventId = params.id;

    // Find campaign IDs for this event so we can include campaign-scoped jobs
    const campaigns = await prisma.campaign.findMany({
      where: { eventId },
      select: { id: true },
    });
    const campaignIdSet = new Set(campaigns.map((c) => c.id));

    // Fetch recent jobs and filter to this event's scope
    const allJobs = await prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
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
        qualityFlags: true,
      },
    });

    const jobs = allJobs.filter((j) => {
      const p = j.payload as Record<string, unknown> | null;
      if (!p) return false;
      if (p.eventId === eventId) return true;
      if (p.campaignId && campaignIdSet.has(p.campaignId as string)) return true;
      return false;
    });

    return NextResponse.json({ jobs });
  } catch (error) {
    console.error("GET /events/[id]/jobs error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch jobs" },
      { status: 500 }
    );
  }
}
