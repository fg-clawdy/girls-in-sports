import { NextResponse } from "next/server";
import { generateCompositionScript, isCompositionConfigured } from "@/lib/composer";
import type { CompositionInput } from "@/lib/composer";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { event, assets, outputType, userIntent } = body;

    if (!event || !Array.isArray(assets) || !outputType) {
      return NextResponse.json(
        { error: "event, assets array, and outputType are required" },
        { status: 400 }
      );
    }

    const input: CompositionInput = {
      event,
      assets: assets.map((a: any) => ({
        assetId: String(a.assetId || a.id || ""),
        fileName: String(a.fileName || a.originalFileName || "unnamed"),
        type: a.type === "VIDEO" ? "VIDEO" : "IMAGE",
        aiScore: a.aiScore ? Number(a.aiScore) : undefined,
        aiReasons: Array.isArray(a.aiReasons) ? a.aiReasons.map(String) : undefined,
      })),
      outputType,
      userIntent: userIntent || undefined,
    };

    const { script, modelUsed } = await generateCompositionScript(input);

    return NextResponse.json({
      success: true,
      script,
      modelUsed,
      compositionConfigured: isCompositionConfigured(),
    });
  } catch (error) {
    console.error("Composition generation error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Composition generation failed",
      },
      { status: 500 }
    );
  }
}
