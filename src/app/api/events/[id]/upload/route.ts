import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob, JobType } from "@/lib/job-worker";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!event.immichAlbumId) {
      return NextResponse.json(
        { error: "Event has no Immich album linked" },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    const results: Array<{
      fileName: string;
      assetId?: string;
      immichAssetId?: string;
      status: "uploaded" | "failed";
      error?: string;
    }> = [];

    for (const file of files) {
      try {
        // ── Stream to Immich ──
        const now = new Date().toISOString();
        const immichForm = new FormData();
        immichForm.append(
          "assetData",
          // File extends Blob — pass directly to avoid loading entire file into memory
          file,
          file.name
        );
        immichForm.append("deviceAssetId", `${file.name}-${Date.now()}`);
        immichForm.append("deviceId", "gis-web-upload");
        immichForm.append("fileCreatedAt", now);
        immichForm.append("fileModifiedAt", now);

        const uploadRes = await fetch(`${IMMICH_URL}/api/assets`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "x-api-key": IMMICH_KEY,
          },
          body: immichForm,
        });

        if (!uploadRes.ok) {
          const text = await uploadRes.text();

          // Create Asset record as FAILED
          await prisma.asset.create({
            data: {
              eventId: params.id,
              type: file.type.startsWith("video") ? "SOURCE_VIDEO" : "SOURCE_IMAGE",
              status: "FAILED",
              filePath: file.name,
              sizeBytes: file.size,
            },
          });

          results.push({
            fileName: file.name,
            status: "failed",
            error: `Immich upload failed: ${uploadRes.status} ${text}`,
          });
          continue;
        }

        const uploadData = await uploadRes.json();
        const immichAssetId = uploadData.id;

        if (!immichAssetId) {
          results.push({
            fileName: file.name,
            status: "uploaded",
            error: "Duplicate or no asset ID returned from Immich",
          });
          continue;
        }

        // ── Deduplication guard: skip if this event already has this immichAssetId ──
        const existingAsset = await prisma.asset.findFirst({
          where: { eventId: params.id, immichAssetId },
        });
        if (existingAsset) {
          results.push({
            fileName: file.name,
            assetId: existingAsset.id,
            immichAssetId,
            status: "uploaded",
            error: "Duplicate upload detected — skipped",
          });
          continue;
        }

        // ── Add to album ──
        await fetch(`${IMMICH_URL}/api/albums/${event.immichAlbumId}/assets`, {
          method: "PUT",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-api-key": IMMICH_KEY,
          },
          body: JSON.stringify({ ids: [immichAssetId] }),
        });

        // ── Create Asset record ──
        const asset = await prisma.asset.create({
          data: {
            eventId: params.id,
            immichAssetId,
            type: file.type.startsWith("video") ? "SOURCE_VIDEO" : "SOURCE_IMAGE",
            status: "UPLOADED",
            filePath: file.name,
            sizeBytes: file.size,
          },
        });

        // ── Enqueue INGEST_CLIP job ──
        await enqueueJob(JobType.INGEST_CLIP, {
          assetId: asset.id,
          immichAssetId,
          eventId: params.id,
          eventName: event.name,
          fileName: file.name,
          activityTags: (event.activityTags as string[]) ?? [],
        });

        results.push({
          fileName: file.name,
          assetId: asset.id,
          immichAssetId,
          status: "uploaded",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";

        // Create Asset record as FAILED
        await prisma.asset.create({
          data: {
            eventId: params.id,
            type: file.type.startsWith("video") ? "SOURCE_VIDEO" : "SOURCE_IMAGE",
            status: "FAILED",
            filePath: file.name,
            sizeBytes: file.size,
          },
        });

        results.push({
          fileName: file.name,
          status: "failed",
          error: msg,
        });
      }
    }

    // ── Update Event status if any assets were created ──
    const uploadedCount = results.filter((r) => r.status === "uploaded").length;
    if (uploadedCount > 0) {
      await prisma.event.update({
        where: { id: params.id },
        data: { status: "INGESTING" },
      });
    }

    return NextResponse.json(
      {
        success: true,
        uploaded: uploadedCount,
        results,
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("Event upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
