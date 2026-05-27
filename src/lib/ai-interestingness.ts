// ═══════════════════════════════════════════════════════════════════════════════
// AI INTERESTINGNESS ANALYSIS (S1-06)
// Two capabilities for continuous cell-phone videos:
//   1. Temporal Interestingness — split video into windows, score each for excitement
//   2. Quote Quality — identify the most quotable/memorable lines from transcripts
//
// All AI calls go through Venice API (chat/completions endpoint).
// No local memory impact beyond frame buffers already handled by score-clip.
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync } from "fs";
import { createLogger } from "./logger";

const VENICE_API_URL =
  process.env.VISION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VISION_API_KEY || process.env.VENICE_API_KEY || "";
const LLM_MODEL = process.env.INTERESTINGNESS_MODEL || process.env.VISION_MODEL || "z-ai-glm-5v-turbo";
const LLM_MODEL_TEXT = process.env.INTERESTINGNESS_TEXT_MODEL || "llama-3.3-70b";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A scored temporal window within the video */
export interface WindowScore {
  windowIndex: number;
  startTime: number;
  endTime: number;
  interestingnessScore: number; // 0–100
  description: string; // 1-2 sentence description of what's happening
  hasAction: boolean;
  hasEmotion: boolean;
  hasPeakMoment: boolean;
}

/** A scored quotable line from the transcript */
export interface QuoteScore {
  text: string;
  startTime: number;
  endTime: number;
  speakerLabel: string | null;
  quoteQualityScore: number; // 0–100: how memorable/quotable/impactful
  reason: string; // why this quote stands out
}

/** Result of temporal interestingness analysis */
export interface InterestingnessResult {
  windows: WindowScore[];
  topWindowIndices: number[]; // sorted by score descending
  averageInterestingness: number;
  modelUsed: string;
  totalApiCalls: number;
  failedApiCalls: number;
}

/** Result of quote quality analysis */
export interface QuoteQualityResult {
  quotes: QuoteScore[];
  topQuoteIndices: number[]; // sorted by qualityScore descending
  averageQuoteQuality: number;
  modelUsed: string;
}

// ── 1. Temporal Interestingness ────────────────────────────────────────────────

/**
 * Split a video into equal-length windows and score each one for interestingness.
 *
 * For each window:
 *   - Extract 3 evenly-spaced keyframes
 *   - Send the frames + context to Venice Vision AI
 *   - Get back: interestingnessScore, description, flags
 *
 * Windows are ~8 seconds by default (optimized for sports action).
 */
export async function analyzeTemporalInterestingness(
  videoPath: string,
  duration: number,
  options?: {
    windowDuration?: number; // default 8 seconds
    framesPerWindow?: number; // default 3
    maxWindows?: number; // default 40 (covers ~5min video at 8s windows)
    sport?: string;
    eventName?: string;
  }
): Promise<InterestingnessResult> {
  const windowDuration = options?.windowDuration ?? 8;
  const framesPerWindow = options?.framesPerWindow ?? 3;
  const maxWindows = options?.maxWindows ?? 40;
  const sport = options?.sport ?? "youth sports";
  const eventName = options?.eventName ?? "unknown";

  const totalWindows = Math.min(Math.ceil(duration / windowDuration), maxWindows);
  if (totalWindows === 0) {
    return {
      windows: [
        {
          windowIndex: 0,
          startTime: 0,
          endTime: duration,
          interestingnessScore: 50,
          description: "Clip too short for windowing",
          hasAction: false,
          hasEmotion: false,
          hasPeakMoment: false,
        },
      ],
      topWindowIndices: [0],
      averageInterestingness: 50,
      modelUsed: "fallback",
      totalApiCalls: 0,
      failedApiCalls: 0,
    };
  }

  // Build window definitions
  const windows: Omit<WindowScore, "interestingnessScore" | "description" | "hasAction" | "hasEmotion" | "hasPeakMoment">[] = [];
  for (let i = 0; i < totalWindows; i++) {
    const start = i * windowDuration;
    const end = Math.min((i + 1) * windowDuration, duration);
    windows.push({ windowIndex: i, startTime: start, endTime: end });
  }

  // Extract frames per window. We batch multiple windows into one API call to reduce latency.
  // Each batch = up to 5 windows × 3 frames = 15 images per API call (well within context limits).
  const WINDOWS_PER_BATCH = 5;
  const batches: { windowIndex: number; startTime: number; endTime: number; framePaths: string[] }[][] = [];

  for (let b = 0; b < windows.length; b += WINDOWS_PER_BATCH) {
    const batchWindows = windows.slice(b, b + WINDOWS_PER_BATCH);
    const batch: { windowIndex: number; startTime: number; endTime: number; framePaths: string[] }[] = [];

    for (const w of batchWindows) {
      // Extract frames at evenly-spaced positions within the window
      const frameTimestamps: number[] = [];
      for (let f = 0; f < framesPerWindow; f++) {
        const ts = w.startTime + (w.endTime - w.startTime) * ((f + 1) / (framesPerWindow + 1));
        frameTimestamps.push(ts);
      }
      batch.push({
        windowIndex: w.windowIndex,
        startTime: w.startTime,
        endTime: w.endTime,
        framePaths: [], // will be filled by extractFrames
      });
    }

    batches.push(batch);
  }

  // Extract all needed frames
  const tmpDir = `/tmp/gis/interestingness-${Math.random().toString(36).slice(2, 8)}`;
  await import("fs/promises").then((fs) => fs.mkdir(tmpDir, { recursive: true }));
  const { spawnLimitedFfmpeg } = await import("./ffmpeg-utils");
  const { join } = await import("path");

  try {
    // Extract frames in parallel per batch
    for (const batch of batches) {
      const extractPromises: Promise<void>[] = [];
      for (const w of batch) {
        const frameTimestamps: number[] = [];
        for (let f = 0; f < framesPerWindow; f++) {
          const ts = w.startTime + (w.endTime - w.startTime) * ((f + 1) / (framesPerWindow + 1));
          frameTimestamps.push(ts);
        }
        const paths: string[] = [];
        for (let f = 0; f < frameTimestamps.length; f++) {
          const ts = frameTimestamps[f];
          const outPath = join(tmpDir, `w${w.windowIndex}_f${f}.jpg`);
          paths.push(outPath);
          extractPromises.push(
            new Promise<void>((resolve, reject) => {
              const { proc } = spawnLimitedFfmpeg(
                ["-ss", ts.toFixed(3), "-i", videoPath, "-frames:v", "1", "-q:v", "2", "-y", outPath],
                { nice: 15, timeoutMs: 60_000, logTag: "ai-interestingness:extract" }
              );
              proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Frame extraction failed at ${ts}s`))));
              proc.on("error", reject);
            })
          );
        }
        w.framePaths = paths;
      }
      await Promise.all(extractPromises);
    }

    // Now score each batch via Venice Vision API
    let totalApiCalls = 0;
    let failedApiCalls = 0;
    const allWindowScores: WindowScore[] = [];

    for (const batch of batches) {
      totalApiCalls++;
      const result = await scoreBatchWithVision(batch, sport, eventName);

      if (result) {
        allWindowScores.push(...result);
      } else {
        failedApiCalls++;
        // Fallback: assign default scores to each window in this batch
        for (const w of batch) {
          allWindowScores.push({
            windowIndex: w.windowIndex,
            startTime: w.startTime,
            endTime: w.endTime,
            interestingnessScore: 30, // below threshold, won't be selected
            description: "Vision API unavailable — default score",
            hasAction: false,
            hasEmotion: false,
            hasPeakMoment: false,
          });
        }
      }
    }

    // Sort and build result
    const sorted = [...allWindowScores].sort((a, b) => b.interestingnessScore - a.interestingnessScore);
    const avgInterestingness = allWindowScores.length > 0
      ? allWindowScores.reduce((sum, w) => sum + w.interestingnessScore, 0) / allWindowScores.length
      : 50;

    return {
      windows: allWindowScores.sort((a, b) => a.windowIndex - b.windowIndex),
      topWindowIndices: sorted.slice(0, Math.min(5, sorted.length)).map((w) => w.windowIndex),
      averageInterestingness: Math.round(avgInterestingness),
      modelUsed: LLM_MODEL,
      totalApiCalls,
      failedApiCalls,
    };
  } finally {
    // Cleanup tmp frames
    try { await import("fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true, force: true })); } catch {}
  }
}

async function scoreBatchWithVision(
  batch: { windowIndex: number; startTime: number; endTime: number; framePaths: string[] }[],
  sport: string,
  eventName: string
): Promise<WindowScore[] | null> {
  if (!VENICE_API_KEY) return null;

  const SYSTEM_PROMPT = `You are a youth sports video analyst for Girls In Sports (GIS).
Your task: For each temporal window (identified by its windowIndex), rate how EXCITING and INTERESTING the content is for a highlights video.

A high score means: peak action, clear emotion, something memorable happening, a moment parents would want to see.
A low score means: static/uneventful, just walking around, nothing distinctive happening, dead time.

For each window, return:
- windowIndex (the number provided)
- interestingnessScore (0-100)
- description (1 sentence describing what's happening in the video)
- hasAction (boolean: is there obvious sports action/movement?)
- hasEmotion (boolean: are faces visible showing joy, effort, celebration?)
- hasPeakMoment (boolean: is this a peak/critical moment — e.g., jump, splash, goal, celebration, collision?)

Return ONLY a valid JSON array. No markdown, no explanations.`;

  // Build message content: intro text + images grouped by window
  const content: any[] = [
    {
      type: "text",
      text: `Analyze ${batch.length} temporal windows from a ${sport} youth sports video at event "${eventName}". Each window is ~8 seconds long. I will show you 3 keyframes per window, labeled by windowIndex. Return JSON with scores for each window.`,
    },
  ];

  for (const w of batch) {
    // Add label
    content.push({
      type: "text",
      text: `Window ${w.windowIndex} (${w.startTime.toFixed(1)}s–${w.endTime.toFixed(1)}s):`,
    });
    // Add frames
    for (const fp of w.framePaths) {
      try {
        const buf = readFileSync(fp);
        content.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
        });
      } catch {
        // Frame file missing — skip
      }
    }
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 180_000); // 3 minutes for batch
  const log = createLogger({ stage: "AI_INTERESTINGNESS" });

  try {
    const res = await fetch(`${VENICE_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        max_tokens: 1500,
        temperature: 0.2,
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      log.warn({ status: res.status }, "Vision API error in interestingness batch");
      return null;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";

    // Parse JSON
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : raw;
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) return null;

    const windowScores: WindowScore[] = parsed.map((item: any) => ({
      windowIndex: Number(item.windowIndex) || 0,
      startTime: batch.find((b) => b.windowIndex === Number(item.windowIndex))?.startTime ?? 0,
      endTime: batch.find((b) => b.windowIndex === Number(item.windowIndex))?.endTime ?? 0,
      interestingnessScore: Math.min(100, Math.max(0, Number(item.interestingnessScore) || 30)),
      description: String(item.description || ""),
      hasAction: Boolean(item.hasAction),
      hasEmotion: Boolean(item.hasEmotion),
      hasPeakMoment: Boolean(item.hasPeakMoment),
    }));

    // Fill in any windows that were in the batch but missing from the response
    for (const w of batch) {
      if (!windowScores.find((ws) => ws.windowIndex === w.windowIndex)) {
        windowScores.push({
          windowIndex: w.windowIndex,
          startTime: w.startTime,
          endTime: w.endTime,
          interestingnessScore: 30,
          description: "Not scored by AI — default",
          hasAction: false,
          hasEmotion: false,
          hasPeakMoment: false,
        });
      }
    }

    return windowScores;
  } catch (err) {
    log.warn({ err }, "Failed to score interestingness batch");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── 2. Quote Quality Analysis ──────────────────────────────────────────────────

/**
 * Analyze a transcript to identify the most quotable, memorable, and impactful lines.
 * Uses a text-only LLM call (cheaper than vision).
 *
 * Input: transcript text + speaker segments with timestamps
 * Output: ranked quotes with quality scores and reasons
 */
export async function analyzeQuoteQuality(
  transcript: string,
  speakerSegments: Array<{ speakerLabel: string; start: number; end: number; text: string }>,
  options?: {
    maxQuotes?: number; // default 5
    sport?: string;
    eventName?: string;
  }
): Promise<QuoteQualityResult> {
  const maxQuotes = options?.maxQuotes ?? 5;
  const sport = options?.sport ?? "youth sports";
  const eventName = options?.eventName ?? "unknown";

  if (!VENICE_API_KEY || !transcript.trim()) {
    return {
      quotes: [],
      topQuoteIndices: [],
      averageQuoteQuality: 0,
      modelUsed: "fallback",
    };
  }

  const log = createLogger({ stage: "AI_QUOTE_QUALITY" });

  // Build a structured transcript for the LLM
  const transcriptLines = speakerSegments.length > 0
    ? speakerSegments.map((s) => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.speakerLabel}: "${s.text}"`)
    : transcript
        .split(/[.!?]+/)
        .filter((s) => s.trim().length > 10)
        .map((s, i) => `[segment ${i}] "${s.trim()}"`);

  const structuredTranscript = transcriptLines.join("\n");
  if (!structuredTranscript.trim()) {
    return { quotes: [], topQuoteIndices: [], averageQuoteQuality: 0, modelUsed: "fallback" };
  }

  const SYSTEM_PROMPT = `You are a video editing assistant for Girls In Sports (GIS), a youth sports highlight platform.
Your task: Identify the most QUOTABLE, MEMORABLE, and IMPACTFUL lines from a transcript of a youth sports video.

Criteria for a great quotable line:
- Emotional impact: inspirational, funny, or touching
- Brevity: short, punchy, easy to remember
- Authenticity: sounds genuine, not generic
- Relevance: captures the spirit of youth sports — encouragement, teamwork, coaching wisdom, joy
- Action-driving: lines that would make a great voiceover or text overlay in a highlight reel

Avoid: generic filler ("good job", "nice"), long rambling sentences, unclear/inaudible speech.

Return a JSON object with a "quotes" array. Each quote object must have:
- "text": the exact quote text
- "quoteQualityScore": 0-100 rating
- "reason": 1 sentence explaining why this is a great quote
- "startTime": approximate start time in seconds (from the transcript prefix)
- "endTime": approximate end time in seconds

Return the top ${maxQuotes} quotes, sorted by quoteQualityScore descending. Return ONLY valid JSON, no markdown.`;

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 60_000);

  try {
    const res = await fetch(`${VENICE_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL_TEXT,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Analyze this youth sports video transcript from a ${sport} event "${eventName}". Find the ${maxQuotes} most quotable lines.\n\nTranscript:\n${structuredTranscript}`,
          },
        ],
        max_tokens: 1200,
        temperature: 0.3,
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      log.warn({ status: res.status }, "Quote quality API error");
      return { quotes: [], topQuoteIndices: [], averageQuoteQuality: 0, modelUsed: LLM_MODEL_TEXT };
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";

    // Parse JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const rawQuotes = Array.isArray(parsed.quotes) ? parsed.quotes : Array.isArray(parsed) ? parsed : [];

    const quotes: QuoteScore[] = rawQuotes
      .map((q: any) => ({
        text: String(q.text || "").trim(),
        startTime: Number(q.startTime) || 0,
        endTime: Number(q.endTime) || 0,
        speakerLabel: null as string | null, // will be mapped from speakerSegments below
        quoteQualityScore: Math.min(100, Math.max(0, Number(q.quoteQualityScore) || 0)),
        reason: String(q.reason || ""),
      }))
      .filter((q: QuoteScore) => q.text.length > 0 && q.quoteQualityScore > 0);

    // Map speaker labels from speakerSegments by time overlap
    for (const quote of quotes) {
      const overlapping = speakerSegments.filter(
        (s) => s.start <= quote.endTime && s.end >= quote.startTime
      );
      if (overlapping.length > 0) {
        // Use the speaker with the most overlap
        const best = overlapping.reduce((best, curr) => {
          const overlap = Math.min(curr.end, quote.endTime) - Math.max(curr.start, quote.startTime);
          const bestOverlap = Math.min(best.end, quote.endTime) - Math.max(best.start, quote.startTime);
          return overlap > bestOverlap ? curr : best;
        });
        quote.speakerLabel = best.speakerLabel;
      }
    }

    // Sort by score descending
    quotes.sort((a, b) => b.quoteQualityScore - a.quoteQualityScore);
    const topIndices = quotes.slice(0, maxQuotes).map((_, i) => i);
    const avgQuality = quotes.length > 0
      ? quotes.reduce((sum, q) => sum + q.quoteQualityScore, 0) / quotes.length
      : 0;

    return {
      quotes,
      topQuoteIndices: topIndices,
      averageQuoteQuality: Math.round(avgQuality),
      modelUsed: LLM_MODEL_TEXT,
    };
  } catch (err) {
    log.warn({ err }, "Failed to analyze quote quality");
    return { quotes: [], topQuoteIndices: [], averageQuoteQuality: 0, modelUsed: LLM_MODEL_TEXT };
  } finally {
    clearTimeout(timeout);
  }
}

// ── 3. Utility: Build clip segments from interestingness windows ───────────────

/**
 * Convert interestingness windows into concrete segment time ranges suitable
 * for creating child CLIP assets or rendering segments.
 *
 * @param windows  Scored temporal windows sorted by time
 * @param threshold  Windows with interestingnessScore >= this are kept (default 50)
 * @param maxSegments  Maximum number of output segments (default 5)
 * @param mergeGap  Merge adjacent windows if gap <= this many seconds (default 3)
 */
export function buildSegmentsFromWindows(
  windows: WindowScore[],
  options?: {
    threshold?: number;
    maxSegments?: number;
    mergeGap?: number;
  }
): { startTime: number; endTime: number; score: number; description: string }[] {
  const threshold = options?.threshold ?? 50;
  const maxSegments = options?.maxSegments ?? 5;
  const mergeGap = options?.mergeGap ?? 3;

  // Filter above threshold and sort by time
  const good = windows
    .filter((w) => w.interestingnessScore >= threshold)
    .sort((a, b) => a.startTime - b.startTime);

  if (good.length === 0) {
    // No windows above threshold — return the single best window (or nothing)
    const best = [...windows].sort((a, b) => b.interestingnessScore - a.interestingnessScore)[0];
    if (!best) return [];
    return [
      {
        startTime: best.startTime,
        endTime: best.endTime,
        score: best.interestingnessScore,
        description: best.description,
      },
    ];
  }

  // Merge adjacent/nearby windows into segments
  const merged: (typeof good)[] = [];
  let current: typeof good = [good[0]];

  for (let i = 1; i < good.length; i++) {
    const prev = good[i - 1];
    const curr = good[i];
    if (curr.startTime - prev.endTime <= mergeGap) {
      current.push(curr);
    } else {
      merged.push(current);
      current = [curr];
    }
  }
  merged.push(current);

  // Convert clusters to segments
  const segments = merged.map((cluster) => {
    const startTime = cluster[0].startTime;
    const endTime = cluster[cluster.length - 1].endTime;
    const score = Math.round(cluster.reduce((sum, w) => sum + w.interestingnessScore, 0) / cluster.length);
    const descriptions = cluster.map((w) => w.description).filter(Boolean);
    const description = descriptions.length > 0 ? descriptions.join(" | ") : "Interesting segment";
    return { startTime, endTime, score, description };
  });

  // Sort by score descending and take top N
  return segments.sort((a, b) => b.score - a.score).slice(0, maxSegments);
}

/**
 * Convert quote scores into temporal segments suitable for extraction.
 */
export function buildSegmentsFromQuotes(
  quotes: QuoteScore[],
  options?: {
    threshold?: number; // quotes with qualityScore >= this are kept (default 60)
    maxSegments?: number;
    padSeconds?: number; // pad before/after each quote (default 1.5)
  }
): { startTime: number; endTime: number; score: number; description: string; quoteText: string }[] {
  const threshold = options?.threshold ?? 60;
  const maxSegments = options?.maxSegments ?? 4;
  const padSeconds = options?.padSeconds ?? 1.5;

  return quotes
    .filter((q) => q.quoteQualityScore >= threshold)
    .slice(0, maxSegments)
    .map((q) => ({
      startTime: Math.max(0, q.startTime - padSeconds),
      endTime: q.endTime + padSeconds,
      score: q.quoteQualityScore,
      description: q.reason,
      quoteText: q.text,
    }));
}