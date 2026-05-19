import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const clips = await prisma.asset.findMany({
      where: {
        eventId: params.id,
        type: "CLIP",
        status: "SCORED",
      },
      include: {
        clipScore: true,
        assetTags: true,
      },
      orderBy: {
        clipScore: {
          compositeScore: "desc",
        },
      },
    });

    return NextResponse.json({ event, clips });
  } catch (error) {
    console.error("GET /events/[id]/clips error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch clips" },
      { status: 500 }
    );
  }
}
