/**
 * resolveSceneCut
 * Given a (possibly child) Asset and the script-proposed [start, end] relative to that clip,
 * returns the correct Immich asset to download and the absolute cut times in that source video.
 *
 * Rules:
 * - Real child CLIP (different immichAssetId from parent, or no parent): cut directly in the child's video at script times.
 * - Legacy virtual scene (child shares immich with parent + has startTimeMs on child): translate script 0-based times by child's base offset in the parent.
 */
export function resolveSceneCut(params: {
  asset: {
    id: string;
    parentAssetId: string | null;
    immichAssetId: string;
    startTimeMs: number | null;
    endTimeMs: number | null;
    durationSeconds: number | null;
  };
  parentAsset?: {
    id: string;
    immichAssetId: string;
  } | null;
  scriptStartMs: number;
  scriptEndMs: number;
}): {
  downloadImmichId: string;
  cutStartMs: number;
  cutEndMs: number;
} {
  const { asset, parentAsset, scriptStartMs, scriptEndMs } = params;

  const isLegacyVirtual =
    !!asset.parentAssetId &&
    !!parentAsset &&
    asset.immichAssetId === parentAsset.immichAssetId &&
    asset.startTimeMs != null;

  if (isLegacyVirtual) {
    const base = asset.startTimeMs as number;
    return {
      downloadImmichId: parentAsset!.immichAssetId,
      cutStartMs: base + Math.max(0, scriptStartMs),
      cutEndMs: base + scriptEndMs,
    };
  }

  // Real child or full asset: direct
  return {
    downloadImmichId: asset.immichAssetId,
    cutStartMs: Math.max(0, scriptStartMs),
    cutEndMs: scriptEndMs,
  };
}
