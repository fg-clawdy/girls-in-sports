import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  try {
    const { eventId, sourceAssetId, rating, generatedAssetId } = await request.json();

    if (!eventId || !sourceAssetId || !rating) {
      return NextResponse.json(
        { error: "eventId, sourceAssetId, and rating are required" },
        { status: 400 }
      );
    }

    if (rating !== "POSITIVE" && rating !== "NEGATIVE") {
      return NextResponse.json(
        { error: "rating must be POSITIVE or NEGATIVE" },
        { status: 400 }
      );
    }

    const feedback = await prisma.feedbackRating.create({
      data: {
        eventId,
        sourceAssetId,
        generatedAssetId: generatedAssetId || null,
        rating,
      },
    });

    return NextResponse.json({ success: true, feedback });
  } catch (error) {
    console.error("Feedback creation error:", error);
    return NextResponse.json(
      { error: "Failed to save feedback" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get("eventId");

  try {
    const where = eventId ? { eventId } : {};
    const feedback = await prisma.feedbackRating.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        event: {
          select: { id: true, name: true },
        },
      },
    });

    return NextResponse.json({ success: true, feedback });
  } catch (error) {
    console.error("Feedback fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500 }
    );
  }
}
