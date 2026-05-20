import { NextResponse } from "next/server";
import { syncTagsFromImmich } from "@/lib/immich";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const count = await syncTagsFromImmich(params.id);
    return NextResponse.json({ synced: count });
  } catch (error) {
    console.error("POST /events/[id]/sync-tags error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync tags" },
      { status: 500 }
    );
  }
}
