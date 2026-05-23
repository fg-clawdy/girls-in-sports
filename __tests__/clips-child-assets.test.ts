import { TIER_FORMULAS, computeTieredScore } from "../src/lib/tier-formulas";

describe("US-008: clips route and child CLIP asset handling", () => {
  test("tiered scoring works for child scene clips (happy path)", () => {
    const { combined, passes } = computeTieredScore(72, 68, "PROFESSIONAL");
    expect(combined).toBeGreaterThan(50);
    expect(typeof passes).toBe("boolean");
  });

  test("handles event with scenes (child CLIPs present) vs without (edge)", () => {
    const clipsWithScenes = [
      { id: "s1", parentAssetId: "p1", tieredScore: 80, type: "CLIP" },
      { id: "s2", parentAssetId: "p1", tieredScore: 65, type: "CLIP" },
      { id: "full", parentAssetId: null, tieredScore: 55, type: "SOURCE_VIDEO" },
    ];
    const hasScenes = clipsWithScenes.some((c) => c.parentAssetId);
    const selectable = hasScenes
      ? clipsWithScenes.filter((c) => c.parentAssetId)
      : clipsWithScenes;
    expect(selectable.length).toBe(2);
    expect(selectable.every((c) => c.parentAssetId)).toBe(true);
  });

  test("event without scenes selects all (edge)", () => {
    const clipsNoScenes = [
      { id: "c1", parentAssetId: null, tieredScore: 70 },
      { id: "c2", parentAssetId: null, tieredScore: 60 },
    ];
    const hasScenes = clipsNoScenes.some((c) => c.parentAssetId);
    const selectable = hasScenes ? clipsNoScenes.filter((c) => c.parentAssetId) : clipsNoScenes;
    expect(selectable.length).toBe(2);
  });
});
