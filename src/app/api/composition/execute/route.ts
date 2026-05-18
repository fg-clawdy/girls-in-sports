import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { executeComposition } from "@/lib/media-engine";
import type { CollageScript, VideoScript } from "@/lib/composer";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { script, eventId } = body;

    if (!script || !script.type) {
      return NextResponse.json(
        { error: "script with type field is required" },
        { status: 400 }
      );
    }

    if (!eventId) {
      return NextResponse.json(
        { error: "eventId is required" },
        { status: 400 }
      );
    }

    // Verify event exists
    const event = await prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      return NextResponse.json(
        { error: "Event not found" },
        { status: 404 }
      );
    }

    // Create a pending GeneratedAsset record
    const generatedAsset = await prisma.generatedAsset.create({
      data: {
        eventId,
        outputType: script.type === "collage" ? "COLLAGE_POSTER" : "WRAP_UP_VIDEO",
        status: "IN_PROGRESS",
        filePath: "", // will update after execution
        fileName: "",
        fileSize: 0,
      },
    });

    // Execute the composition (this may take time)
    const result = await executeComposition(
      script as CollageScript | VideoScript,
      generatedAsset.id
    );

    // Update the record with the result
    await prisma.generatedAsset.update({
      where: { id: generatedAsset.id },
      data: {
        status: "COMPLETED",
        filePath: result.filePath,
        fileName: result.fileName,
        fileSize: result.sizeBytes,
      },
    });

    return NextResponse.json({
      success: true,
      generatedAssetId: generatedAsset.id,
      type: result.type,
      fileName: result.fileName,
      fileSize: result.sizeBytes,
      filePath: result.filePath,
    });
  } catch (error) {
    console.error("Composition execution error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Composition execution failed",
      },
      { status: 500 }
    );
  }
}
