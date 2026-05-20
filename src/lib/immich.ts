import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const IMMICH_URL = process.env.IMMICH_API_URL || "http://localhost:2283";
const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

function getHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": IMMICH_KEY,
  };
}

// --- Albums ---

export interface ImmichAlbum {
  id: string;
  albumName: string;
  description: string;
  albumThumbnailAssetId: string | null;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
  albumUsers: Array<{
    user: { id: string; email: string; name: string };
    role: string;
  }>;
  assets: ImmichAsset[];
}

export interface ImmichAsset {
  id: string;
  type: string; // "IMAGE" | "VIDEO"
  originalPath: string;
  originalFileName: string;
  resizePath: string | null;
  deviceAssetId: string;
  deviceId: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  updatedAt: string;
  isFavorite: boolean;
  isArchived: boolean;
  isTrashed: boolean;
  duration: string;
  exifInfo?: {
    make?: string;
    model?: string;
    lensModel?: string;
    fNumber?: number;
    iso?: number;
    exposureTime?: string;
    fps?: number;
    description?: string;
    latitude?: number;
    longitude?: number;
    city?: string;
    state?: string;
    country?: string;
  };
  thumbnailPath: string | null;
  previewPath: string | null;
}

export async function getAllAlbums(): Promise<ImmichAlbum[]> {
  const res = await fetch(`${IMMICH_URL}/api/albums`, {
    headers: getHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Immich albums fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getAlbum(albumId: string): Promise<ImmichAlbum> {
  const res = await fetch(`${IMMICH_URL}/api/albums/${albumId}?withoutAssets=false`, {
    headers: getHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Immich album fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function createAlbum(
  name: string,
  description?: string,
  assetIds?: string[]
): Promise<ImmichAlbum> {
  const res = await fetch(`${IMMICH_URL}/api/albums`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      albumName: name,
      description: description || "",
      assetIds: assetIds || [],
    }),
  });
  if (!res.ok) {
    throw new Error(`Immich album creation failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Assets ---

export function getAssetThumbnailUrl(assetId: string): string {
  return `${IMMICH_URL}/api/assets/${assetId}/thumbnail?size=thumbnail`;
}

export function getAssetPreviewUrl(assetId: string): string {
  return `${IMMICH_URL}/api/assets/${assetId}/thumbnail?size=preview`;
}

export function getAssetOriginalUrl(assetId: string): string {
  return `${IMMICH_URL}/api/assets/${assetId}/original`;
}

export async function getAssetInfo(assetId: string): Promise<ImmichAsset> {
  const res = await fetch(`${IMMICH_URL}/api/assets/${assetId}`, {
    headers: getHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Immich asset fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Server Info ---

export async function pingServer(): Promise<{ status: string }> {
  const res = await fetch(`${IMMICH_URL}/api/server-info/ping`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Immich ping failed: ${res.status}`);
  }
  return res.json();
}

// Check if Immich is configured
export function isImmichConfigured(): boolean {
  return Boolean(IMMICH_URL && IMMICH_KEY);
}

// --- Download / Upload helpers for worker ---

export async function downloadAssetToFile(
  assetId: string,
  localPath: string
): Promise<void> {
  const res = await fetch(`${IMMICH_URL}/api/assets/${assetId}/original`, {
    headers: {
      Accept: "application/octet-stream",
      "x-api-key": IMMICH_KEY,
    },
  });
  if (!res.ok) {
    throw new Error(`Immich download failed: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("Immich download: empty response body");
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(localPath));
}

export async function uploadAssetFromFile(
  localPath: string,
  deviceAssetId: string,
  fileName: string,
  fileCreatedAt: string,
  fileModifiedAt: string,
  fileType: string
): Promise<string> {
  const form = new FormData();
  const { readFileSync } = await import("fs");
  const buf = readFileSync(localPath);
  form.append("assetData", new Blob([buf], { type: fileType }), fileName);
  form.append("deviceAssetId", deviceAssetId);
  form.append("deviceId", "gis-worker");
  form.append("fileCreatedAt", fileCreatedAt);
  form.append("fileModifiedAt", fileModifiedAt);

  const res = await fetch(`${IMMICH_URL}/api/assets`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "x-api-key": IMMICH_KEY,
    },
    body: form as any,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Immich upload failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.id as string;
}

export async function addAssetsToAlbum(
  albumId: string,
  assetIds: string[]
): Promise<void> {
  const res = await fetch(`${IMMICH_URL}/api/albums/${albumId}/assets`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": IMMICH_KEY,
    },
    body: JSON.stringify({ ids: assetIds }),
  });
  if (!res.ok) {
    throw new Error(`Immich add to album failed: ${res.status}`);
  }
}

export async function updateAssetDescription(
  assetId: string,
  description: string
): Promise<void> {
  const res = await fetch(`${IMMICH_URL}/api/assets/${assetId}`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": IMMICH_KEY,
    },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) {
    throw new Error(`Immich update description failed: ${res.status} ${await res.text()}`);
  }
}

// ── Tag Sync ──────────────────────────────────────────────────

/**
 * Write GIS tags to Immich asset description as newline-separated key:value pairs.
 * This makes tags visible in Immich UI without relying on Immich's tag system.
 */
export async function syncTagsToImmich(
  assetId: string,
  tags: string[]
): Promise<void> {
  if (!IMMICH_KEY) {
    console.warn("[immich] syncTagsToImmich: no API key configured");
    return;
  }

  const existing = await getAssetInfo(assetId);
  const existingDesc = existing.exifInfo?.description || "";

  // Parse existing gis: tags from description
  const lines = existingDesc.split("\n").filter(Boolean);
  const nonGisLines = lines.filter((l) => !l.startsWith("gis:"));

  const gisLines = tags.map((t) => `gis:${t}`);
  const newDescription = [...nonGisLines, ...gisLines].join("\n");

  await updateAssetDescription(assetId, newDescription);
  console.log(`[immich] Synced ${tags.length} tags to asset ${assetId}`);
}

/**
 * Query GIS AssetTag table for assets matching all provided tags.
 * This is the source-of-truth for tag-based filtering — never queries Immich.
 */
export async function searchAssetsByTag(
  tags: string[],
  eventId?: string
): Promise<string[]> {
  const { prisma } = await import("@/lib/prisma");

  const conditions: any[] = tags.map((tag) => ({
    assetTags: { some: { tag } },
  }));

  if (eventId) {
    conditions.push({ eventId });
  }

  const assets = await prisma.asset.findMany({
    where: { AND: conditions },
    select: { id: true, immichAssetId: true },
  });

  return assets.map((a) => a.id);
}

/**
 * Pull tags from Immich asset descriptions back into GIS AssetTag table.
 * Parses `gis:` prefixed key:value pairs from descriptions.
 */
export async function syncTagsFromImmich(eventId: string): Promise<number> {
  const { prisma } = await import("@/lib/prisma");

  const assets = await prisma.asset.findMany({
    where: { eventId, immichAssetId: { not: null } },
    select: { id: true, immichAssetId: true },
  });

  let syncedCount = 0;

  for (const asset of assets) {
    if (!asset.immichAssetId) continue;
    try {
      const info = await getAssetInfo(asset.immichAssetId);
      const desc = info.exifInfo?.description || "";
      const gisTags = desc
        .split("\n")
        .filter((l) => l.startsWith("gis:"))
        .map((l) => l.replace("gis:", "").trim())
        .filter(Boolean);

      for (const tag of gisTags) {
        await prisma.assetTag.upsert({
          where: { assetId_tag: { assetId: asset.id, tag } },
          create: {
            assetId: asset.id,
            tag,
            source: "IMMICH_CLIP",
            confidence: null,
          },
          update: {},
        });
        syncedCount++;
      }
    } catch (err) {
      console.warn(`[immich] syncTagsFromImmich failed for asset ${asset.id}:`, err);
    }
  }

  console.log(`[immich] Synced ${syncedCount} tags from Immich for event ${eventId}`);
  return syncedCount;
}

/**
 * Proxy Immich CLIP smart search. Returns GIS Asset IDs matching the query.
 */
export async function smartSearchImmich(
  query: string,
  eventId?: string
): Promise<string[]> {
  if (!IMMICH_KEY) {
    throw new Error("Immich not configured");
  }

  const res = await fetch(`${IMMICH_URL}/api/search/smart`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ query, clip: true }),
  });

  if (!res.ok) {
    throw new Error(`Immich smart search failed: ${res.status}`);
  }

  const data = await res.json();
  const immichIds: string[] = (data.assets?.items || []).map((item: any) => item.id);

  if (immichIds.length === 0) return [];

  // Resolve immichAssetIds back to GIS Asset records
  const { prisma } = await import("@/lib/prisma");
  const conditions: any = { immichAssetId: { in: immichIds } };
  if (eventId) conditions.eventId = eventId;

  const assets = await prisma.asset.findMany({
    where: conditions,
    select: { id: true },
  });

  return assets.map((a) => a.id);
}
