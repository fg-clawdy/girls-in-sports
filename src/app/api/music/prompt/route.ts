import { NextResponse } from "next/server";
import { generateMusicPromptFromVideo } from "@/lib/music-generation";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { eventName, sport, compositionType, targetTempo } = body;

    if (!eventName || !sport) {
      return NextResponse.json(
        { error: "eventName and sport are required" },
        { status: 400 }
      );
    }

    const prompt = await generateMusicPromptFromVideo(
      eventName,
      sport,
      compositionType || "wrapup",
      targetTempo || "upbeat"
    );

    return NextResponse.json({ success: true, prompt });
  } catch (error) {
    console.error("Music prompt generation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate prompt" },
      { status: 500 }
    );
  }
}
