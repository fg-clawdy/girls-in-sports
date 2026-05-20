import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { prisma } = await import("@/lib/prisma");

    const campaign = await prisma.campaign.findUnique({
      where: { id: params.id },
      select: { eventId: true },
    });

    if (!campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    // Return the eventId so the UI can navigate to curate
    return NextResponse.json({ eventId: campaign.eventId, cleared: true });
  } catch (error) {
    console.error("POST /campaigns/[id]/create-another error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
