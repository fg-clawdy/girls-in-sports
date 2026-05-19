import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const segments = await prisma.sceneSegment.findMany({
      where: { eventId: params.id },
      orderBy: [{ parentId: "asc" }, { startTime: "asc" }],
    });

    // Group by parentId
    const grouped = segments.reduce((acc, seg) => {
      if (!acc[seg.parentId]) {
        acc[seg.parentId] = [];
      }
      acc[seg.parentId].push({
        id: seg.id,
        startTime: seg.startTime,
        endTime: seg.endTime,
        duration: seg.duration,
        motionScore: seg.motionScore,
      });
      return acc;
    }, {} as Record<string, any[]>);

    return NextResponse.json({
      success: true,
      segments: grouped,
      totalScenes: segments.length,
    });
  } catch (error) {
    console.error("Scene segments fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch scene segments" },
      { status: 500 }
    );
  }
}
