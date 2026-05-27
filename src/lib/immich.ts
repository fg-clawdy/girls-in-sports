import { createWriteStream, createReadStream, statSync } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const METADATA_FETCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_UPLOAD_TIMEOUT_MS = 120_000;

function timedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...rest, signal: ac.signal }).finally(() => clearTimeout(timer));
}

function getImmichUrl(): string {
  return process.env.IMMICH_API_URL || "http://localhost:2283";
}

function getImmichKey(): string {
  return process.env.IMMICH_API_KEY || "";
}

function getHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": getImmichKey(),
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
  const res = await timedFetch(`${getImmichUrl()}/api/albums`, {
    headers: getHeaders(),
    timeoutMs: METADATA_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`Immich albums fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getAlbum(albumId: string): Promise<ImmichAlbum> {
  const res = await timedFetch(`${getImmichUrl()}/api/albums/${albumId}?withoutAssets=false`, {
    headers: getHeaders(),
    cache: "no-store",
    timeoutMs: METADATA_FETCH_TIMEOUT_MS,
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
  const res = await timedFetch(`${getImmichUrl()}/api/albums`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      albumName: name,
      description: description || "",
      assetIds: assetIds || [],
    }),
    timeoutMs: METADATA_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`Immich album creation failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Assets ---

export function getAssetThumbnailUrl(assetId: string): string {
  return `${getImmichUrl()}/api/assets/${assetId}/thumbnail?size=thumbnail`;
}

export function getAssetPreviewUrl(assetId: string): string {
  return `${getImmichUrl()}/api/assets/${assetId}/thumbnail?size=preview`;
}

export function getAssetOriginalUrl(assetId: string): string {
  return `${getImmichUrl()}/api/assets/${assetId}/original`;
}

export async function getAssetInfo(assetId: string): Promise<ImmichAsset> {
  const res = await timedFetch(`${getImmichUrl()}/api/assets/${assetId}`, {
    headers: getHeaders(),
    timeoutMs: METADATA_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`Immich asset fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Server Info ---

export async function pingServer(): Promise<{ status: string }> {
  const res = await timedFetch(`${getImmichUrl()}/api/server-info/ping`, {
    headers: { Accept: "application/json" },
    timeoutMs: METADATA_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`Immich ping failed: ${res.status}`);
  }
  return res.json();
}

// Check if Immich is configured
export function isImmichConfigured(): boolean {
  return Boolean(getImmichUrl() && getImmichKey());
}

// --- Download / Upload helpers for worker ---

export async function downloadAssetToFile(
  assetId: string,
  localPath: string
): Promise<void> {
  const res = await timedFetch(`${getImmichUrl()}/api/assets/${assetId}/original`, {
    headers: {
      Accept: "application/octet-stream",
      "x-api-key": getImmichKey(),
    },
    timeoutMs: DOWNLOAD_UPLOAD_TIMEOUT_MS,
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
  // Stream the file in 64KB chunks instead of loading entirely into RAM
  // This is the single largest OOM culprit — readFileSync on 50-500MB clips.
  const { size } = statSync(localPath);
  const fileStream = createReadStream(localPath, { highWaterMark: 64 * 1024 });

  // Build a streaming FormData-compatible body using a ReadableStream
  const boundary = `----FormBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  function fieldString(name: string, value: string): string {
    return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }

  const prelude = (
    fieldString("deviceAssetId", deviceAssetId) +
    fieldString("deviceId", "gis-worker") +
    fieldString("fileCreatedAt", fileCreatedAt) +
    fieldString("fileModifiedAt", fileModifiedAt) +
    `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`
  );

  const trailer = `\r\n--${boundary}--\r\n`;

  // Create a single Readable that emits prelude, file stream, trailer
  const combined = new Readable({
    read() {},
  });

  combined.push(prelude);
  fileStream.on("data", (chunk) => combined.push(chunk));
  fileStream.on("end", () => combined.push(trailer));
  fileStream.on("error", (err) => combined.destroy(err));

  const res = await timedFetch(`${getImmichUrl()}/api/assets`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "x-api-key": getImmichKey(),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(
        prelude.length + size + trailer.length
      ),
    },
    body: Readable.toWeb(combined) as any,
    ...({ duplex: "half" } as any),
    timeoutMs: DOWNLOAD_UPLOAD_TIMEOUT_MS,
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
  const res = await timedFetch(`${getImmichUrl()}/api/albums/${albumId}/assets`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": getImmichKey(),
    },
    body: JSON.stringify({ ids: assetIds }),
    timeoutMs: METADATA_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`Immich add to album failed: ${res.status}`);
  }
}

export async function updateAssetDescription(
  assetId: string,
  description: string
): Promise<void> {
  const res = await timedFetch(`${getImmichUrl()}/api/assets/${assetId}`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": getImmichKey(),
    },
    body: JSON.stringify({ description }),
    timeoutMs: METADATA_FETCH_TIMEOUT_MS,
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
  if (!getImmichKey()) {
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
  if (!getImmichKey()) {
    throw new Error("Immich not configured");
  }

  const res = await fetch(`${getImmichUrl()}/api/search/smart`, {
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
