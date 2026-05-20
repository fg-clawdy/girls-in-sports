import { NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";

const JWT_SECRET = new TextEncoder().encode(
  process.env.SHARE_JWT_SECRET || process.env.NEXTAUTH_SECRET || "gis-share-secret-fallback"
);

// 72h expiry
const SHARE_TTL_SECONDS = 72 * 3600;

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { prisma } = await import("@/lib/prisma");

    const campaign = await prisma.campaign.findUnique({
      where: { id: params.id },
      select: { id: true, finalAssetId: true },
    });

    if (!campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    const finalAsset = campaign.finalAssetId
      ? await prisma.asset.findUnique({
          where: { id: campaign.finalAssetId },
          select: { immichAssetId: true },
        })
      : null;

    if (!finalAsset?.immichAssetId) {
      return NextResponse.json({ error: "Final video not ready" }, { status: 400 });
    }

    const token = await new SignJWT({
      campaignId: campaign.id,
      immichAssetId: finalAsset.immichAssetId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${SHARE_TTL_SECONDS}s`)
      .sign(JWT_SECRET);

    // Build the share URL — Next.js on local network or domain
    const host = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const shareUrl = `${host}/share/${token}`;

    return NextResponse.json({ shareUrl, expiresIn: SHARE_TTL_SECONDS });
  } catch (error) {
    console.error("POST /campaigns/[id]/share error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create share link" },
      { status: 500 }
    );
  }
}
