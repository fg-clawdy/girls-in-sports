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
  return `${IMMICH_URL}/api/assets/${assetId}/thumbnail?size=thumbnail&key=${IMMICH_KEY}`;
}

export function getAssetPreviewUrl(assetId: string): string {
  return `${IMMICH_URL}/api/assets/${assetId}/thumbnail?size=preview&key=${IMMICH_KEY}`;
}

export function getAssetOriginalUrl(assetId: string): string {
  return `${IMMICH_URL}/api/assets/${assetId}/original?key=${IMMICH_KEY}`;
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
