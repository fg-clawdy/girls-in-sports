import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

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

    return NextResponse.json({ event });
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
