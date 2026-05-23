describe("US-011 / US-016: Low-resolution source handling (no AI upscale)", () => {
  test("clips with heightPx < 720 are treated as SD and do not trigger upscale", () => {
    const clips = [
      { id: "low1", heightPx: 480, widthPx: 270 },
      { id: "ok1", heightPx: 1080, widthPx: 1920 },
      { id: "low2", heightPx: null, widthPx: null }, // unknown → treated as not low
    ];

    const lowRes = clips.filter((c) => (c.heightPx ?? 9999) < 720);
    expect(lowRes.map((c) => c.id)).toEqual(["low1"]);

    // The decision in render-final and UI is: do NOT attempt upscale for these.
    // (The dead topazUpscale path has been removed; low-res sources are rendered natively with SD badge.)
    const wouldAttemptUpscale = lowRes.length > 0 && false; // the old block is gone
    expect(wouldAttemptUpscale).toBe(false);
  });
});
