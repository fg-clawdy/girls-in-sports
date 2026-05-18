import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const asset = await prisma.generatedAsset.findUnique({
      where: { id: params.id },
      include: {
        event: {
          select: {
            id: true,
            name: true,
            sport: true,
            city: true,
            eventDate: true,
            immichAlbumId: true,
          },
        },
      },
    });

    if (!asset) {
      return NextResponse.json(
        { error: "Result not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, asset });
  } catch (error) {
    console.error("Result detail error:", error);
    return NextResponse.json(
      { error: "Failed to fetch result" },
      { status: 500 }
    );
  }
}
