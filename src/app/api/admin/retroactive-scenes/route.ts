import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processUnscenedVideosForEvent } from "@/lib/scene-detection-service";

/**
 * POST /api/admin/retroactive-scenes
 *
 * Retroactive batch job: scans all events with Immich albums and runs
 * scene detection on any videos that haven't been processed yet.
 *
 * Idempotent — safe to run multiple times. Already-processed videos are skipped.
 *
 * Response:
 *   {
 *     success: true,
 *     totalEvents: number,
 *     processedEvents: number,
 *     totalVideosProcessed: number,
 *     totalFailed: number,
 *     details: [{ eventId, eventName, processed, failed }, ...]
 *   }
 */
export async function POST() {
  try {
    // Fetch all events that have an Immich album
    const events = await prisma.event.findMany({
      where: {
        immichAlbumId: { not: null },
      },
      select: {
        id: true,
        name: true,
        immichAlbumId: true,
      },
    });

    const details: Array<{
      eventId: string;
      eventName: string;
      processed: number;
      failed: number;
    }> = [];

    let totalVideosProcessed = 0;
    let totalFailed = 0;
    let processedEvents = 0;

    for (const event of events) {
      if (!event.immichAlbumId) continue;

      try {
        const result = await processUnscenedVideosForEvent(
          event.id,
          event.immichAlbumId
        );

        totalVideosProcessed += result.processed;
        totalFailed += result.failed;
        processedEvents++;

        details.push({
          eventId: event.id,
          eventName: event.name,
          processed: result.processed,
          failed: result.failed,
        });

        console.log(
          `Retroactive scenes: event "${event.name}" — ${result.processed} processed, ${result.failed} failed`
        );
      } catch (err) {
        console.error(`Retroactive scenes failed for event ${event.id}:`, err);
        totalFailed++;
        details.push({
          eventId: event.id,
          eventName: event.name,
          processed: 0,
          failed: 1, // event-level failure
        });
      }
    }

    return NextResponse.json({
      success: true,
      totalEvents: events.length,
      processedEvents,
      totalVideosProcessed,
      totalFailed,
      details,
    });
  } catch (error) {
    console.error("Retroactive scene detection error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Retroactive scene detection failed",
      },
      { status: 500 }
    );
  }
}
