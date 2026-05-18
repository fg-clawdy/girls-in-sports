import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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

    const uploadedAssetIds: string[] = [];
    const errors: string[] = [];

    for (const file of files) {
      try {
        // Upload to Immich with required metadata
        const now = new Date().toISOString();
        const immichForm = new FormData();
        immichForm.append("assetData", new Blob([await file.arrayBuffer()], { type: file.type }), file.name);
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
          errors.push(`${file.name}: ${uploadRes.status} ${text}`);
          continue;
        }

        const uploadData = await uploadRes.json();
        if (uploadData.id) {
          uploadedAssetIds.push(uploadData.id);
        } else if (uploadData.duplicate) {
          // Already exists — skip, no error
          continue;
        }
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : "Upload failed"}`);
      }
    }

    // Add uploaded assets to the event's album
    if (uploadedAssetIds.length > 0) {
      await fetch(`${IMMICH_URL}/api/albums/${event.immichAlbumId}/assets`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": IMMICH_KEY,
        },
        body: JSON.stringify({ ids: uploadedAssetIds }),
      });
    }

    return NextResponse.json({
      success: true,
      uploaded: uploadedAssetIds.length,
      assetIds: uploadedAssetIds,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Event upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
