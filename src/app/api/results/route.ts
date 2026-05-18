import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const assets = await prisma.generatedAsset.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            sport: true,
            city: true,
            eventDate: true,
          },
        },
      },
    });

    return NextResponse.json({ success: true, assets });
  } catch (error) {
    console.error("Results catalog error:", error);
    return NextResponse.json(
      { error: "Failed to fetch results" },
      { status: 500 }
    );
  }
}
