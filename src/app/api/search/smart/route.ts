import { NextResponse } from "next/server";
import { smartSearchImmich } from "@/lib/immich";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { query, eventId } = body;

    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const assetIds = await smartSearchImmich(query, eventId);
    return NextResponse.json({ assetIds });
  } catch (error) {
    console.error("POST /search/smart error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 }
    );
  }
}
