import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

// Force dynamic so a brand-new event is immediately visible on hard refresh
// of /events/[id] (prevents Next.js from serving a cached 404 or stale payload)
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const event = await prisma.event.findUnique({
      where: { id: params.id },
      include: { generatedAssets: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const res = NextResponse.json({ event });
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return res;
  } catch (error) {
    console.error("Get event error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch event" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { name, sport, city, eventDate, description, qualityTier, costBudgetUSD } = body;

    if (costBudgetUSD !== undefined) {
      const adminCheck = await requireAdmin(request as any);
      if (adminCheck instanceof NextResponse) return adminCheck;
    }
    const event = await prisma.event.update({
      where: { id: params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(sport !== undefined && { sport }),
        ...(city !== undefined && { city }),
        ...(eventDate !== undefined && { eventDate: new Date(eventDate) }),
        ...(description !== undefined && { description }),
        ...(qualityTier !== undefined && { qualityTier }),
        ...(costBudgetUSD !== undefined && { costBudgetUSD: Number(costBudgetUSD) }),
      },
    });

    return NextResponse.json({ event });
  } catch (error) {
    console.error("Update event error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update event" },
      { status: 500 }
    );
  }
}
