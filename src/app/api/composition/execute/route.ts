import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { executeComposition } from "@/lib/media-engine";
import {
  estimateCompositionCost,
  shouldGenerateABVariant,
} from "@/lib/cost-estimator";
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

    // Estimate cost for A/B decision
    const costEstimate = estimateCompositionCost({
      event,
      assets: script.clips || script.images || [],
      outputType: script.type,
    });

    // Generate Variant A
    const variantA = await prisma.generatedAsset.create({
      data: {
        eventId,
        outputType: script.type === "collage" ? "COLLAGE_POSTER" : "WRAP_UP_VIDEO",
        status: "IN_PROGRESS",
        filePath: "",
        fileName: "",
        fileSize: 0,
        costDIEM: costEstimate.estimatedDIEM,
        compositionScript: JSON.stringify(script),
      },
    });

    // Execute Variant A
    const resultA = await executeComposition(
      script as CollageScript | VideoScript,
      variantA.id
    );

    await prisma.generatedAsset.update({
      where: { id: variantA.id },
      data: {
        status: "COMPLETED",
        filePath: resultA.filePath,
        fileName: resultA.fileName,
        fileSize: resultA.sizeBytes,
      },
    });

    // US-011: Check if we should generate Variant B
    let variantB = null;
    if (
      shouldGenerateABVariant(costEstimate.estimatedDIEM) &&
      script.type !== "collage"
    ) {
      // Create Variant B with modified params
      const variantBScript = JSON.parse(JSON.stringify(script)) as VideoScript;
      // Reduce clip durations by 0.7x
      for (const clip of variantBScript.clips || []) {
        clip.duration = Math.max(0.5, (clip.duration || 2) * 0.7);
      }
      // Force all transitions to "cut"
      for (const clip of variantBScript.clips || []) {
        clip.transition = "cut";
      }

      variantB = await prisma.generatedAsset.create({
        data: {
          eventId,
          outputType: "WRAP_UP_VIDEO",
          status: "IN_PROGRESS",
          filePath: "",
          fileName: "",
          fileSize: 0,
          costDIEM: costEstimate.estimatedDIEM,
          compositionScript: JSON.stringify(variantBScript),
        },
      });

      try {
        const resultB = await executeComposition(variantBScript, variantB.id);
        await prisma.generatedAsset.update({
          where: { id: variantB.id },
          data: {
            status: "COMPLETED",
            filePath: resultB.filePath,
            fileName: resultB.fileName,
            fileSize: resultB.sizeBytes,
          },
        });
      } catch (err) {
        console.error("Variant B generation failed:", err);
        await prisma.generatedAsset.update({
          where: { id: variantB.id },
          data: {
            status: "FAILED",
            errorMessage: err instanceof Error ? err.message : "Variant B failed",
          },
        });
      }
    }

    return NextResponse.json({
      success: true,
      generatedAssetId: variantA.id,
      variantBId: variantB?.id || null,
      type: resultA.type,
      fileName: resultA.fileName,
      fileSize: resultA.sizeBytes,
      filePath: resultA.filePath,
      costDIEM: costEstimate.estimatedDIEM,
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
