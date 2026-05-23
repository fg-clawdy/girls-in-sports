import { recordJobError, recordQualityFlags, markPartialSuccess } from "../src/lib/handlers/quality-tracking";

// Hoisting-safe mocks (Jest factories run before top-level const/let in the test file)
let mockFindUnique: jest.Mock;
let mockUpdate: jest.Mock;
let mockRecordJobOutcome: jest.Mock;

jest.mock("../src/lib/prisma", () => ({
  prisma: {
    job: {
      findUnique: (...args: any[]) => mockFindUnique?.(...args),
      update: (...args: any[]) => mockUpdate?.(...args),
    },
  },
}));

jest.mock("../src/lib/cost-estimator", () => ({
  recordJobOutcome: (...args: any[]) => mockRecordJobOutcome?.(...args),
}));

describe("US-014: quality flag + error recording (used by score-clip, generate-music, render-*, ingest-clip, etc.)", () => {
  beforeEach(() => {
    mockFindUnique = jest.fn();
    mockUpdate = jest.fn();
    mockRecordJobOutcome = jest.fn();
  });

  test("recordJobError writes top-level error and triggers per-stage qualityFlags (failed: true) — score-clip / render error path", async () => {
    // First find for recordJobError itself, second find inside the recordQualityFlags it calls
    mockFindUnique
      .mockResolvedValueOnce({ id: "job-err-1", qualityFlags: {}, payload: { eventId: "evt-1" } })
      .mockResolvedValueOnce({ id: "job-err-1", qualityFlags: {}, payload: { eventId: "evt-1" } });

    await recordJobError("job-err-1", new Error("Venice vision 429"), "score-clip");

    // Top-level error written
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-err-1" },
        data: { error: "Venice vision 429" },
      })
    );

    // Per-stage quality flag also written (via the helper)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-err-1" },
        data: expect.objectContaining({
          qualityFlags: expect.objectContaining({
            "score-clip": expect.objectContaining({
              failed: true,
              error: "Venice vision 429",
            }),
          }),
        }),
      })
    );

    // Circuit breaker triggered on failure
    expect(mockRecordJobOutcome).toHaveBeenCalledWith("evt-1", false);
  });

  test("recordQualityFlags merges stage-specific flags (visionFailedBatches + fallback) and triggers circuit on failed — score-clip partial vision path", async () => {
    mockFindUnique.mockResolvedValue({
      id: "job-vision-1",
      qualityFlags: { "score-clip": { previous: true } },
      payload: { eventId: "evt-vision" },
    });

    await recordQualityFlags("job-vision-1", "score-clip", {
      visionFailedBatches: 3,
      visionUsedFallback: true,
      failed: true,
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-vision-1" },
        data: expect.objectContaining({
          qualityFlags: expect.objectContaining({
            "score-clip": expect.objectContaining({
              visionFailedBatches: 3,
              visionUsedFallback: true,
              failed: true,
              timestamp: expect.any(String),
            }),
          }),
        }),
      })
    );

    expect(mockRecordJobOutcome).toHaveBeenCalledWith("evt-vision", false);
  });

  test("markPartialSuccess records fallbackUsed + message — generate-music model fallback / timeout path", async () => {
    mockFindUnique.mockResolvedValue({
      id: "job-music-1",
      qualityFlags: {},
      payload: { eventId: "evt-music" },
    });

    await markPartialSuccess("job-music-1", "generate-music", "Both models failed — render continues without music", {
      fallbackUsed: true,
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-music-1" },
        data: expect.objectContaining({
          qualityFlags: expect.objectContaining({
            "generate-music": expect.objectContaining({
              fallbackUsed: true,
              message: "Both models failed — render continues without music",
              timestamp: expect.any(String),
            }),
          }),
        }),
      })
    );
  });

  test("recordJobError on timeout (non-fatal) still records for quality dashboard — generate-music timeout path", async () => {
    mockFindUnique
      .mockResolvedValueOnce({ id: "job-timeout", qualityFlags: {}, payload: { eventId: "evt-t" } })
      .mockResolvedValueOnce({ id: "job-timeout", qualityFlags: {}, payload: { eventId: "evt-t" } });

    await recordJobError("job-timeout", "Music generation timed out", "generate-music");

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-timeout" },
        data: { error: "Music generation timed out" },
      })
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          qualityFlags: expect.objectContaining({
            "generate-music": expect.objectContaining({ failed: true }),
          }),
        }),
      })
    );
  });

  test("no-op and no DB writes when jobId is missing (defensive)", async () => {
    await recordJobError(undefined, "some error", "score-clip");
    await recordQualityFlags(undefined as any, "foo", { failed: true });
    await markPartialSuccess(undefined, "bar", "msg");

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRecordJobOutcome).not.toHaveBeenCalled();
  });
});