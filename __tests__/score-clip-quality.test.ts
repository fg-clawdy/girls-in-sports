import { analyzeKeyframesWithVision } from "../src/lib/handlers/score-clip";
import fs from "fs";
import path from "path";
import os from "os";

describe("US-014: vision qualityFlags via analyzeKeyframesWithVision", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gis-vision-test-"));

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function makeDummyFrame(name: string): string {
    const p = path.join(tmpDir, name);
    // minimal valid-ish jpeg header so readFileSync + base64 works
    fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    return p;
  }

  beforeEach(() => {
    jest.resetModules();
    process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-key";
    process.env.VISION_API_URL = "https://api.venice.ai/api/v1";
  });

  test("non-2xx Venice response sets visionFailedBatches > 0 and visionUsedFallback=true with degraded scores", async () => {
    const frame = makeDummyFrame("fail.jpg");

    const origFetch = global.fetch;
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });

    const result = await analyzeKeyframesWithVision([frame], "basketball");

    expect(result.visionFailedBatches).toBeGreaterThan(0);
    expect(result.visionUsedFallback).toBe(true);
    expect(result.momentScore).toBe(50);
    expect(result.productionScore).toBe(40);

    (global as any).fetch = origFetch;
  });

  test("successful Venice JSON response returns zero failures, no fallback, and parsed scores", async () => {
    const frame = makeDummyFrame("ok.jpg");

    const origFetch = global.fetch;
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ momentScore: 87, productionScore: 64 }),
            },
          },
        ],
      }),
    });

    const result = await analyzeKeyframesWithVision([frame], "soccer");

    expect(result.visionFailedBatches).toBe(0);
    expect(result.visionUsedFallback).toBe(false);
    expect(result.momentScore).toBe(87);
    expect(result.productionScore).toBe(64);

    (global as any).fetch = origFetch;
  });
});
