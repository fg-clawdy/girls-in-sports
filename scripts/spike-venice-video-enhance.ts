import { promises as fs } from "fs";
import { join } from "path";

const VENICE_URL = process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_KEY = process.env.VENICE_API_KEY || "";

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("Usage: npx tsx scripts/spike-venice-video-enhance.ts <path-to-small-vertical-clip.mp4>");
    process.exit(1);
  }

  if (!VENICE_KEY) {
    console.error("VENICE_API_KEY is required in environment");
    process.exit(1);
  }

  console.log("=== Venice Video Enhance Spike (US-016) ===");
  console.log("Target:", videoPath);
  console.log("VENICE_URL:", VENICE_URL);

  const buf = await fs.readFile(videoPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "video/mp4" }), "clip.mp4");
  form.append("upscale_factor", "2");
  form.append("model", "topaz-video-2x");

  const t0 = Date.now();
  const res = await fetch(`${VENICE_URL}/video/enhance`, {
    method: "POST",
    headers: { Authorization: `Bearer ${VENICE_KEY}` },
    body: form as any,
  });

  const t1 = Date.now();
  console.log("POST /video/enhance status:", res.status, "latencyMs:", t1 - t0);

  const text = await res.text();
  console.log("Response body (truncated):", text.slice(0, 2000));

  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    console.log("RESULT: FAILED (non-2xx on initial call)");
    process.exit(0);
  }

  const jobId = data.job_id || data.id || data.task_id;
  if (!jobId) {
    console.log("RESULT: POSSIBLY SYNC — no job id returned. Output may be in response.");
    console.log("Full parsed:", JSON.stringify(data, null, 2).slice(0, 4000));
    process.exit(0);
  }

  console.log("Job ID:", jobId);
  console.log("Polling for completion (max 10 min)...");

  const pollUrl = `${VENICE_URL}/video/enhance/${jobId}`;
  const start = Date.now();
  let final: any = null;

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pr = await fetch(pollUrl, { headers: { Authorization: `Bearer ${VENICE_KEY}` } });
    const ptext = await pr.text();
    let pjson: any;
    try { pjson = JSON.parse(ptext); } catch { pjson = { raw: ptext }; }

    console.log(`Poll ${i + 1}: status=${pr.status} body=${ptext.slice(0, 300)}`);

    if (pjson.status === "completed" || pjson.output_url || pjson.url) {
      final = pjson;
      break;
    }
    if (pjson.status === "failed" || pjson.error) {
      final = pjson;
      break;
    }
    if (Date.now() - start > 10 * 60 * 1000) break;
  }

  const totalMs = Date.now() - t0;
  console.log("Total elapsed ms:", totalMs);

  if (final && (final.output_url || final.url)) {
    console.log("RESULT: SUCCESS — output available at:", final.output_url || final.url);
    console.log("Full final payload:", JSON.stringify(final, null, 2).slice(0, 2000));
  } else if (final && final.status === "failed") {
    console.log("RESULT: FAILED — job reported failure");
  } else {
    console.log("RESULT: TIMEOUT or UNKNOWN — no usable output after polling window");
  }

  console.log("=== Spike complete ===");
}

main().catch(e => { console.error(e); process.exit(1); });
