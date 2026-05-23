import { resolveSceneCut } from "../src/lib/resolve-scene-cut";

describe("US-010: resolveSceneCut (child CLIP timing translation)", () => {
  test("legacy virtual scene (same immich as parent + timing on child) translates 0-based script times to absolute parent times", () => {
    const result = resolveSceneCut({
      asset: {
        id: "child123",
        parentAssetId: "parent456",
        immichAssetId: "immich-src",
        startTimeMs: 12000,
        endTimeMs: 20500,
        durationSeconds: 8.5,
      },
      parentAsset: { id: "parent456", immichAssetId: "immich-src" },
      scriptStartMs: 0,
      scriptEndMs: 3500,
    });

    expect(result.downloadImmichId).toBe("immich-src");
    expect(result.cutStartMs).toBe(12000);
    expect(result.cutEndMs).toBe(15500);
  });

  test("real child CLIP (own immichAssetId) uses direct 0-based cuts in its own video", () => {
    const result = resolveSceneCut({
      asset: {
        id: "child789",
        parentAssetId: "parent456",
        immichAssetId: "immich-clip-999", // different from parent
        startTimeMs: 0,
        endTimeMs: 5200,
        durationSeconds: 5.2,
      },
      parentAsset: { id: "parent456", immichAssetId: "immich-src" },
      scriptStartMs: 1200,
      scriptEndMs: 4700,
    });

    expect(result.downloadImmichId).toBe("immich-clip-999");
    expect(result.cutStartMs).toBe(1200);
    expect(result.cutEndMs).toBe(4700);
  });

  test("full SOURCE_VIDEO (no parent) passes script times through unchanged", () => {
    const result = resolveSceneCut({
      asset: {
        id: "full1",
        parentAssetId: null,
        immichAssetId: "immich-full",
        startTimeMs: null,
        endTimeMs: null,
        durationSeconds: 120,
      },
      parentAsset: null,
      scriptStartMs: 3000,
      scriptEndMs: 8000,
    });

    expect(result.downloadImmichId).toBe("immich-full");
    expect(result.cutStartMs).toBe(3000);
    expect(result.cutEndMs).toBe(8000);
  });
});
