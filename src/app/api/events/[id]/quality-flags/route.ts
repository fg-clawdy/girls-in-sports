import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const flags = await prisma.assetQualityFlag.findMany({
      where: { eventId: params.id },
    });
    return NextResponse.json({ flags });
  } catch (error) {
    console.error("Quality flags fetch error:", error);
    return NextResponse.json({ flags: [] });
  }
}
