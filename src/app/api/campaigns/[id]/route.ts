import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { JobType } from "@/lib/job-worker";
import { enqueueJob } from "@/lib/job-worker";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { userFeedbackJson, status } = body;

    const updateData: any = {};
    if (userFeedbackJson !== undefined) updateData.userFeedbackJson = userFeedbackJson;
    if (status !== undefined) updateData.status = status;

    const campaign = await prisma.campaign.update({
      where: { id: params.id },
      data: updateData,
    });

    return NextResponse.json({ campaign });
  } catch (error) {
    console.error("PATCH /campaigns/[id] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update campaign" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === "approve") {
      const campaign = await prisma.campaign.update({
        where: { id: params.id },
        data: { status: "APPROVED" },
      });

      // Enqueue RENDER_FINAL
      await enqueueJob(JobType.RENDER_FINAL, {
        campaignId: params.id,
        eventId: campaign.eventId,
      });

      return NextResponse.json({ campaign });
    }

    if (action === "regenerate-music") {
      const campaign = await prisma.campaign.findUnique({
        where: { id: params.id },
      });
      if (!campaign) {
        return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
      }

      await enqueueJob(JobType.GENERATE_MUSIC, {
        campaignId: params.id,
        eventId: campaign.eventId,
      });

      return NextResponse.json({ queued: true });
    }

    if (action === "start-over") {
      const campaign = await prisma.campaign.update({
        where: { id: params.id },
        data: { status: "SCRIPTED" },
      });
      return NextResponse.json({ campaign });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("POST /campaigns/[id] action error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
