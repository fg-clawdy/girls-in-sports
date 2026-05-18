import { NextResponse } from "next/server";
import {
  getMusicModels,
  queueMusicGeneration,
  pollForMusic,
} from "@/lib/music-generation";

export async function GET() {
  try {
    const models = await getMusicModels();
    return NextResponse.json({ success: true, models });
  } catch (error) {
    console.error("Get music models error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch models" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { model, prompt, lyrics, durationSeconds, forceInstrumental } = body;

    if (!model || !prompt) {
      return NextResponse.json(
        { error: "model and prompt are required" },
        { status: 400 }
      );
    }

    // Step 1: Queue the generation
    const { queueId, model: usedModel } = await queueMusicGeneration({
      model,
      prompt,
      lyrics,
      durationSeconds,
      forceInstrumental,
    });

    // Step 2: Poll for completion
    const result = await pollForMusic(queueId, usedModel, 60, 5000);

    return NextResponse.json({
      success: result.status === "COMPLETED",
      queueId: result.queueId,
      model: result.model,
      status: result.status,
      filePath: result.filePath,
      fileName: result.fileName,
      error: result.error,
    });
  } catch (error) {
    console.error("Music generation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Music generation failed" },
      { status: 500 }
    );
  }
}
