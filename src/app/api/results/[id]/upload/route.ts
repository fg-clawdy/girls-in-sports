import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const asset = await prisma.generatedAsset.findUnique({
      where: { id: params.id },
      include: { event: true },
    });

    if (!asset) {
      return NextResponse.json(
        { error: "Result not found" },
        { status: 404 }
      );
    }

    if (asset.status !== "COMPLETED" || !asset.filePath) {
      return NextResponse.json(
        { error: "Result not ready for upload" },
        { status: 400 }
      );
    }

    // Read the file
    const fileBuffer = await readFile(asset.filePath);
    const fileName = asset.fileName;
    const isVideo = asset.outputType === "WRAP_UP_VIDEO" || asset.outputType === "HIGHLIGHT_VIDEO_15S";

    // Upload to Immich
    const formData = new FormData();
    formData.append("assetData", new Blob([fileBuffer], { type: isVideo ? "video/mp4" : "image/png" }), fileName);

    const uploadRes = await fetch(`${IMMICH_URL}/api/assets`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-api-key": IMMICH_KEY,
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      return NextResponse.json(
        { error: `Immich upload failed: ${uploadRes.status} ${text}` },
        { status: 500 }
      );
    }

    const uploadData = await uploadRes.json();
    const immichAssetId = uploadData.id;

    // Optionally add to the event's album
    if (asset.event?.immichAlbumId && immichAssetId) {
      await fetch(`${IMMICH_URL}/api/albums/${asset.event.immichAlbumId}/assets`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": IMMICH_KEY,
        },
        body: JSON.stringify({ ids: [immichAssetId] }),
      });
    }

    // Update record
    await prisma.generatedAsset.update({
      where: { id: params.id },
      data: { immichAssetId },
    });

    return NextResponse.json({
      success: true,
      immichAssetId,
      message: "Uploaded to Immich successfully",
    });
  } catch (error) {
    console.error("Immich upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
