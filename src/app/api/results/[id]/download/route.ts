import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const asset = await prisma.generatedAsset.findUnique({
      where: { id: params.id },
    });

    if (!asset || !asset.filePath) {
      return NextResponse.json(
        { error: "Result not found" },
        { status: 404 }
      );
    }

    const fileBuffer = await readFile(asset.filePath);
    const isVideo = asset.outputType === "WRAP_UP_VIDEO" || asset.outputType === "HIGHLIGHT_VIDEO_15S";

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": isVideo ? "video/mp4" : "image/png",
        "Content-Disposition": `attachment; filename="${asset.fileName}"`,
      },
    });
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json(
      { error: "Failed to serve file" },
      { status: 500 }
    );
  }
}
