import { NextResponse } from "next/server";
import { analyzeBeats } from "@/lib/beat-sync-service";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { filePath } = body;

    if (!filePath) {
      return NextResponse.json(
        { error: "filePath is required" },
        { status: 400 }
      );
    }

    const result = await analyzeBeats(filePath);

    return NextResponse.json({
      success: true,
      bpm: result.bpm,
      beatTimestamps: result.beatTimestamps,
      confidence: result.confidence,
    });
  } catch (error) {
    console.error("Beat analysis error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Beat analysis failed" },
      { status: 500 }
    );
  }
}
