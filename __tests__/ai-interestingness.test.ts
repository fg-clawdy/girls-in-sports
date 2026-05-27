import {
  buildSegmentsFromWindows,
  buildSegmentsFromQuotes,
  type WindowScore,
  type QuoteScore,
} from "../src/lib/ai-interestingness";
import { estimateInterestingnessCost } from "../src/lib/cost-estimator";

// ── buildSegmentsFromWindows ─────────────────────────────────────────────

describe("buildSegmentsFromWindows", () => {
  const makeWindows = (scores: number[]): WindowScore[] =>
    scores.map((s, i) => ({
      windowIndex: i,
      startTime: i * 8,
      endTime: (i + 1) * 8,
      interestingnessScore: s,
      description: `Window ${i}`,
      hasAction: s >= 60,
      hasEmotion: s >= 50,
      hasPeakMoment: s >= 80,
    }));

  it("returns top segments above threshold", () => {
    const windows = makeWindows([90, 30, 85, 40, 75]);
    const result = buildSegmentsFromWindows(windows, { threshold: 50, maxSegments: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.every((s) => s.score >= 50)).toBe(true);
  });

  it("merges adjacent windows within mergeGap", () => {
    // Windows 1,2,3 are all above threshold and adjacent (8s apart, gap 0)
    // Windows 5 is above threshold but separated from 3 by window 4 (gap 8s > mergeGap 3s)
    const windows = makeWindows([40, 85, 80, 75, 30, 90]);
    const result = buildSegmentsFromWindows(windows, { threshold: 50, maxSegments: 5, mergeGap: 3 });
    // Should merge [1,2,3] into one segment spanning 8–32
    const merged = result.find((s) => s.startTime === 8 && s.endTime === 32);
    expect(merged).toBeDefined();
    // Should have separate segment for window 5 at 40–48
    const separate = result.find((s) => s.startTime === 40);
    expect(separate).toBeDefined();
  });

  it("falls back to best window when none above threshold", () => {
    const windows = makeWindows([20, 35, 45, 30]);
    const result = buildSegmentsFromWindows(windows, { threshold: 50 });
    expect(result.length).toBe(1);
    expect(result[0].score).toBe(45); // best available
  });

  it("returns empty for empty input", () => {
    const result = buildSegmentsFromWindows([], { threshold: 50 });
    expect(result).toEqual([]);
  });

  it("respects maxSegments limit", () => {
    const windows = makeWindows([90, 88, 85, 82, 80, 78, 75]);
    const result = buildSegmentsFromWindows(windows, { threshold: 50, maxSegments: 3, mergeGap: 0 });
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

// ── buildSegmentsFromQuotes ──────────────────────────────────────────────

describe("buildSegmentsFromQuotes", () => {
  const makeQuotes = (scores: number[]): QuoteScore[] =>
    scores.map((s, i) => ({
      text: `Quote ${i}`,
      startTime: i * 10,
      endTime: i * 10 + 3,
      speakerLabel: `Speaker ${i}`,
      quoteQualityScore: s,
      reason: `Reason ${i}`,
    }));

  it("filters quotes below threshold", () => {
    const quotes = makeQuotes([90, 30, 85, 40, 75]);
    const result = buildSegmentsFromQuotes(quotes, { threshold: 60, maxSegments: 5 });
    expect(result.every((s) => s.score >= 60)).toBe(true);
    expect(result.length).toBe(3); // 90, 85, 75
  });

  it("pads segments with default 1.5s on each side", () => {
    const quotes: QuoteScore[] = [
      { text: "Great job!", startTime: 10, endTime: 13, speakerLabel: "Coach", quoteQualityScore: 85, reason: "motivational" },
    ];
    const result = buildSegmentsFromQuotes(quotes, { threshold: 60, padSeconds: 1.5 });
    expect(result[0].startTime).toBeCloseTo(8.5);
    expect(result[0].endTime).toBeCloseTo(14.5);
  });

  it("respects maxSegments limit", () => {
    const quotes = makeQuotes([90, 88, 85, 82, 80, 78]);
    const result = buildSegmentsFromQuotes(quotes, { threshold: 60, maxSegments: 3 });
    expect(result.length).toBe(3);
    expect(result[0].score).toBe(90);
    expect(result[1].score).toBe(88);
    expect(result[2].score).toBe(85);
  });

  it("pads with custom padSeconds", () => {
    const quotes: QuoteScore[] = [
      { text: "Test", startTime: 10, endTime: 12, speakerLabel: "A", quoteQualityScore: 70, reason: "test" },
    ];
    const result = buildSegmentsFromQuotes(quotes, { threshold: 60, padSeconds: 2 });
    expect(result[0].startTime).toBe(8);
    expect(result[0].endTime).toBe(14);
  });

  it("returns empty for empty input", () => {
    const result = buildSegmentsFromQuotes([], { threshold: 60 });
    expect(result).toEqual([]);
  });
});

// ── estimateInterestingnessCost ───────────────────────────────────────────

describe("estimateInterestingnessCost", () => {
  it("estimates cost for a 3-minute video", () => {
    const cost = estimateInterestingnessCost(180);
    // 180s / 8s window ~= 23 windows × 3 frames × $0.015 + $0.002 quote
    // 23 * 3 * 0.015 + 0.002 = 1.035 + 0.002 = 1.037
    expect(cost.estimatedDIEM).toBeCloseTo(1.037, 2);
    expect(cost.visionFrames).toBe(69); // 23 * 3
  });

  it("caps at 40 windows", () => {
    const cost = estimateInterestingnessCost(600); // 10 min video
    // 600/8 = 75 windows → capped at 40
    // 40 * 3 * 0.015 + 0.002 = 1.802
    expect(cost.estimatedDIEM).toBeCloseTo(1.802, 2);
    expect(cost.visionFrames).toBe(120); // 40 * 3
  });

  it("handles very short videos", () => {
    const cost = estimateInterestingnessCost(5);
    // min 1 window: 1 * 3 * 0.015 + 0.002 = 0.047
    expect(cost.visionFrames).toBeGreaterThanOrEqual(3);
    expect(cost.estimatedDIEM).toBeGreaterThan(0);
  });

  it("textTokens is always 0", () => {
    const cost = estimateInterestingnessCost(120);
    expect(cost.textTokens).toBe(0);
  });
});