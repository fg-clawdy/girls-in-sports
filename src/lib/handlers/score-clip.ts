import { PrismaClient, AssetStatus, AssetTagSource, ClipType } from "@prisma/client";
import { spawn } from "child_process";
import { promises as fs, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "../prisma";
import { downloadAssetToFile, updateAssetDescription } from "../immich";
import { computeTieredScore, TIER_FORMULAS } from "../tier-formulas";
import { checkAndReserveBudget, isEventCircuitPaused, recordJobOutcome, refundBudget, estimateScoreClipCost } from "../cost-estimator";
// US-014: centralized quality flag + error recording (graceful degradation, circuit breaker, user-visible messages)
import { createLogger } from "../logger";
import { recordQualityFlags, markPartialSuccess, recordJobError } from "./quality-tracking";

interface ScoreClipPayload {
  assetId: string;
  immichAssetId: string;
  eventId: string;
  eventName?: string;
  parentJobId?: string | null;
}

const TMP_BASE = "/tmp/gis/score";

const VENICE_API_URL = process.env.VISION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VISION_API_KEY || process.env.VENICE_API_KEY || "";
const VISION_MODEL = process.env.VISION_MODEL || "z-ai-glm-5v-turbo";

// Sport-specific keyword lists (configurable)
const SPORT_KEYWORDS: Record<string, string[]> = {
  basketball: ["shoot", "shot", "dribble", "pass", "block", "rebound", "defense", "hustle", "great", "nice shot", "let's go"],
  soccer: ["goal", "score", "pass", "kick", "save", "defense", "hustle", "great", "nice", "let's go"],
  volleyball: ["spike", "set", "dig", "block", "serve", "great", "hustle", "nice", "let's go"],
  default: ["great", "hustle", "defense", "let's go", "nice shot", "good job", "well done", "excellent", "amazing"],
};

export async function handleScoreClip(args: { payload: unknown; jobId: string }): Promise<void> {
  const pl = args.payload as ScoreClipPayload;
  const { assetId, immichAssetId, eventId } = pl;

  // Quality tracking for partial failures (US-014)
  let visionFailedBatches = 0;
  let visionUsedFallback = false;

  const tmpDir = join(TMP_BASE, assetId);
  await fs.mkdir(tmpDir, { recursive: true });
  const sourcePath = join(tmpDir, "source");

  try {
    // ── 1. Download clip from Immich ──
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { event: true },
    });
    if (!asset) throw new Error(`Asset ${assetId} not found`);

    let parentAsset: any = null;
    if (asset.parentAssetId) {
      parentAsset = await prisma.asset.findUnique({ where: { id: asset.parentAssetId } });
    }

    let analysisImmich = immichAssetId;
    let analysisPath = sourcePath;
    let needsWindow = false;
    let winStart = 0;
    let winEnd = asset.durationSeconds || 0;
    if (asset.parentAssetId && asset.startTimeMs != null && asset.endTimeMs != null && parentAsset && asset.immichAssetId === parentAsset.immichAssetId) {
      analysisImmich = parentAsset.immichAssetId;
      needsWindow = true;
      winStart = (asset.startTimeMs || 0) / 1000;
      winEnd = (asset.endTimeMs || 0) / 1000;
    }

    if (needsWindow) {
      const parentSrc = join(tmpDir, "parent");
      await downloadAssetToFile(analysisImmich, parentSrc);
      const winPath = join(tmpDir, "window.mp4");
      await cutWindow(parentSrc, winPath, winStart, winEnd);
      analysisPath = winPath;
      try { await fs.unlink(parentSrc); } catch {}
    } else {
      await downloadAssetToFile(analysisImmich, analysisPath);
    }

    if (isEventCircuitPaused(eventId)) {
      await prisma.asset.update({ where: { id: assetId }, data: { status: "FAILED" } });
      recordJobOutcome(eventId, false);
      throw new Error("Circuit breaker active");
    }
    const est = estimateScoreClipCost(true, true, asset.durationSeconds || 30);
    const bchk = await checkAndReserveBudget(eventId, est.estimatedDIEM);
    if (!bchk.allowed) {
      await prisma.asset.update({ where: { id: assetId }, data: { status: "FAILED" } });
      recordJobOutcome(eventId, false);
      await refundBudget(eventId, est.estimatedDIEM);
      throw new Error(bchk.reason || "budget");
    }

    const analysisDuration = needsWindow ? Math.max(0.1, winEnd - winStart) : (asset.durationSeconds || 0);
    const sport = asset.event?.sport?.toLowerCase() || "default";

    // ── 2. Run STT on raw video (dual-path: Venice beta with diarization primary, Whisper fallback) ──
    const sttResult = await transcribeVideo(analysisPath);
    const { transcript, segments: sttSegments, words, speakerSegments, provider } = sttResult;

    // Persist word-level timestamps on the Asset for downstream speech segmentation (S1-03)
    if (words.length > 0) {
      await prisma.asset.update({
        where: { id: assetId },
        data: {
          transcriptWordsJson: words.map((w) => ({
            word: w.word,
            startMs: Math.round(w.start * 1000),
            endMs: Math.round(w.end * 1000),
          })) as any,
        },
      });
    }

    // ── 3. Compute audio/keyword score (speaker-aware) ──
    const keywords = SPORT_KEYWORDS[sport] || SPORT_KEYWORDS.default;
    const { audioScore, keywordHits, hasCoachSpeech } = computeAudioScore(
      transcript,
      sttSegments,
      keywords,
      speakerSegments,
    );

    // ── 4. Compute motion score EARLY (for clipType + dynamic frame strategy — proposal B) ──
    const motionScore = await computeMotionScore(analysisPath);

    // ── 5. Early clipType (used for type-driven frame extraction) ──
    let clipType = assignClipType(motionScore, audioScore);

    // ── 6. Dynamic frame count based on clipType + analysisDuration (ACTION gets scene+midpoints, SPEECH gets 2-3 even) ──
    let frameCount = 3;
    if (clipType === ClipType.ACTION || clipType === ClipType.MIXED) {
      frameCount = analysisDuration <= 10 ? 6 : 12;
    } else if (clipType === ClipType.SPEECH) {
      frameCount = 3;
    } else {
      frameCount = analysisDuration <= 10 ? 3 : analysisDuration <= 30 ? 6 : 12;
    }

    const framesDir = join(tmpDir, "frames");
    await fs.mkdir(framesDir, { recursive: true });
    const framePaths = await extractKeyframes(analysisPath, framesDir, frameCount, analysisDuration);

    // ── 7. Vision analysis on keyframes — ONLY momentScore + productionScore (proposal A) ──
    let momentScore = 0;
    let productionScore = 0;
    let hasFaces = false; // simplified: no longer returned by vision (can be enhanced with local face detection later)

    if (VENICE_API_KEY && framePaths.length > 0) {
      const visionResults = await analyzeKeyframesWithVision(framePaths, sport);
      momentScore = visionResults.momentScore;
      productionScore = visionResults.productionScore;
      visionFailedBatches = visionResults.visionFailedBatches;
      visionUsedFallback = visionResults.visionUsedFallback;
    }

    // ── 8. Tiered compositeScore using event.qualityTier + transparent TIER_FORMULAS (proposal C + D) ──
    const eventTier = asset.event?.qualityTier ?? "PROFESSIONAL";
    const { combined: composite } = computeTieredScore(momentScore, productionScore, eventTier);

    // ── 9. Upsert ClipScore record (allows re-runs) ──
    const speakerSegmentsJson = speakerSegments.length > 0 ? speakerSegments : null;
    await prisma.clipScore.upsert({
      where: { assetId },
      create: {
        assetId,
        visionScore: Math.round(productionScore),
        audioScore: Math.round(audioScore),
        motionScore: Math.round(motionScore),
        momentScore,
        productionScore,
        compositeScore: composite,
        clipType,
        hasFaces,
        hasCoachSpeech,
        hasActionKeyword: keywordHits.some((k) =>
          ["shoot", "shot", "goal", "score", "spike", "block", "save", "tackle"].includes(k)
        ),
        transcriptExcerpt: transcript.slice(0, 200),
        keywordHits: JSON.stringify(keywordHits),
        transcriptionProvider: provider,
        speakerSegmentsJson: speakerSegmentsJson as any,
      },
      update: {
        visionScore: Math.round(productionScore),
        audioScore: Math.round(audioScore),
        motionScore: Math.round(motionScore),
        momentScore,
        productionScore,
        compositeScore: composite,
        clipType,
        hasFaces,
        hasCoachSpeech,
        hasActionKeyword: keywordHits.some((k) =>
          ["shoot", "shot", "goal", "score", "spike", "block", "save", "tackle"].includes(k)
        ),
        transcriptExcerpt: transcript.slice(0, 200),
        keywordHits: JSON.stringify(keywordHits),
        transcriptionProvider: provider,
        speakerSegmentsJson: speakerSegmentsJson as any,
      },
    });

    // ── 10. Update Asset status ──
    await prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.SCORED },
    });
    recordJobOutcome(eventId, true);

    // ── 11. Write tags to Immich and AssetTag table ──
    const eventSport = asset.event?.sport || "sports";
    const tagDescription = [
      `gis:score=${composite}`,
      `gis:type=${clipType}`,
      `gis:sport=${eventSport}`,
      `gis:hasFaces=${hasFaces}`,
      `gis:hasCoachSpeech=${hasCoachSpeech}`,
    ].join("\n");

    await updateAssetDescription(immichAssetId, tagDescription);

    const tagsToWrite = [
      { tag: `score:${composite}`, confidence: 1.0 },
      { tag: `type:${clipType}`, confidence: 1.0 },
      { tag: `sport:${eventSport}`, confidence: 1.0 },
      ...(hasFaces ? [{ tag: "hasFaces", confidence: 1.0 }] : []),
      ...(hasCoachSpeech ? [{ tag: "hasCoachSpeech", confidence: 1.0 }] : []),
      ...keywordHits.map((k) => ({ tag: k, confidence: 0.8 })),
    ];

    for (const t of tagsToWrite) {
      await prisma.assetTag.upsert({
        where: {
          assetId_tag: { assetId, tag: t.tag },
        },
        update: { confidence: t.confidence, source: AssetTagSource.GIS_AI },
        create: {
          assetId,
          tag: t.tag,
          source: AssetTagSource.GIS_AI,
          confidence: t.confidence,
        },
      });
    }

    const hasManualThumbnailTag = await prisma.assetTag.findFirst({
      where: { tag: "thumbnail", source: "USER_MANUAL", asset: { eventId } },
    });
    if (!hasManualThumbnailTag) {
      const eventAssets = await prisma.asset.findMany({
        where: { eventId, status: AssetStatus.SCORED },
        include: { clipScore: true },
      });
      const scoredAssets = eventAssets.filter((a) => a.clipScore);
      if (scoredAssets.length > 0) {
        const best = scoredAssets.reduce((max, a) =>
          (a.clipScore?.compositeScore || 0) > (max.clipScore?.compositeScore || 0) ? a : max
        );
        if (best.id === assetId && best.immichAssetId) {
          try {
            const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
            const thumbUrl = `${origin}/api/immich/thumbnail/${best.immichAssetId}`;
            const thumbRes = await fetch(thumbUrl);
            if (thumbRes.ok) {
              const blob = await thumbRes.blob();
              const buffer = Buffer.from(await blob.arrayBuffer());
              const thumbnailsDir = join(process.cwd(), "public", "thumbnails");
              await mkdir(thumbnailsDir, { recursive: true });
              const thumbnailPath = join(thumbnailsDir, `${eventId}.jpg`);
              await writeFile(thumbnailPath, buffer);
              await prisma.event.update({
                where: { id: eventId },
                data: { thumbnailUrl: `/thumbnails/${eventId}.jpg` },
              });
            }
          } catch (thumbErr) {
            console.warn("[US-015] Failed to save legacy thumbnail:", thumbErr);
          }
        }
      }
    }

    // ── 13. If all sibling clips are scored, set parent to SCORED and notify ──
    if (asset.parentAssetId) {
      const siblings = await prisma.asset.count({
        where: { parentAssetId: asset.parentAssetId, status: { not: AssetStatus.SCORED } },
      });
      if (siblings === 0) {
        await prisma.asset.update({
          where: { id: asset.parentAssetId },
          data: { status: AssetStatus.SCORED },
        });
      }
    }

// ── 14. Record structured quality flags on the Job (US-014) ──
    // Use centralized helper so failures, fallbacks, and vision batch stats are
    // consistently stored, trigger circuit breakers, and become visible to users.
// US-014: ensure every failure path records the error for user visibility,
// circuit-breaker triggering, and auditability. Re-throw so the worker
// can set final Job status (FAILED / retry / dead-letter).
    await recordQualityFlags(args.jobId, "score-clip", {
      visionFailedBatches,
      visionUsedFallback,
      sttFailed: false,
      transcriptionProvider: provider,
    });
  } catch (err) {
    await recordJobError(args.jobId, err as Error, "score-clip");
    throw err;
  } finally {
    // ── 14. Clean up temp files ──
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUAL-PATH TRANSCRIPTION (S1-02)
// Primary: Venice /audio/transcriptions with diarization enabled
// Fallback: Venice /audio/transcriptions (standard Whisper, no diarization)
// ═══════════════════════════════════════════════════════════════════════════════

interface TranscriptionResult {
  transcript: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: Array<{ word: string; start: number; end: number }>;
  speakerSegments: Array<{ speakerLabel: string; start: number; end: number; text: string }>;
  provider: "venice-beta" | "whisper-fallback";
  fallbackReason?: string;
}

async function transcribeVideo(videoPath: string): Promise<TranscriptionResult> {
  const audioPath = videoPath + ".wav";
  await extractAudioToWav(videoPath, audioPath);

  try {
    // ── PRIMARY: try with diarization ──
    const primary = await tryTranscribe(audioPath, { diarize: true });
    if (primary.speakerSegments.length > 0) {
      return { ...primary, provider: "venice-beta" };
    }

    // ── FALLBACK: standard Whisper without diarization ──
    const fallback = await tryTranscribe(audioPath, { diarize: false });
    return {
      ...fallback,
      provider: "whisper-fallback",
      fallbackReason: "diarization_unavailable",
    };
  } finally {
    try { await fs.unlink(audioPath); } catch { /* ignore cleanup */ }
  }
}

async function tryTranscribe(
  audioPath: string,
  opts: { diarize: boolean }
): Promise<Omit<TranscriptionResult, "provider" | "fallbackReason">> {
  const buf = readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  form.append("model", "openai/whisper-large-v3");
  form.append("response_format", "json");
  form.append("timestamps", "true");
  if (opts.diarize) {
    form.append("diarize", "true");
    form.append("diarize_audio", "true"); // some providers use this key
  }

  const res = await fetch(`${VENICE_API_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${VENICE_API_KEY}` },
    body: form as any,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STT failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const text = data.text || "";

  // Venice nests word timestamps under response.timestamps.word
  const rawWords = data.timestamps?.word || data.words || [];

  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    return {
      transcript: text,
      segments: text ? [{ start: 0, end: 0, text }] : [],
      words: [],
      speakerSegments: [],
    };
  }

  const words = rawWords.map((w: any) => ({
    word: String(w.word || "").trim(),
    start: Number(w.start ?? 0),
    end: Number(w.end ?? 0),
  })).filter((w: any) => w.word.length > 0);

  // Group words into sentence segments
  const segments: Array<{ start: number; end: number; text: string }> = [];
  let currentWords: typeof words = [];

  for (const w of words) {
    if (currentWords.length === 0) { currentWords.push(w); continue; }
    const last = currentWords[currentWords.length - 1];
    const pause = w.start - last.end;
    if (pause > 1.5 || currentWords.length >= 12) {
      segments.push({
        start: currentWords[0].start,
        end: last.end,
        text: currentWords.map((cw: any) => cw.word).join(" "),
      });
      currentWords = [w];
    } else {
      currentWords.push(w);
    }
  }
  if (currentWords.length > 0) {
    segments.push({
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
      text: currentWords.map((cw: any) => cw.word).join(" "),
    });
  }

  // Extract speaker segments from diarization response (if present)
  const speakerSegments: Array<{ speakerLabel: string; start: number; end: number; text: string }> = [];
  const rawSpeakers = data.speakers || data.segments || data.diarization || [];
  if (Array.isArray(rawSpeakers) && rawSpeakers.length > 0) {
    for (const s of rawSpeakers) {
      const label = String(s.speaker || s.speaker_id || s.label || "UNKNOWN").trim();
      const start = Number(s.start ?? s.start_time ?? 0);
      const end = Number(s.end ?? s.end_time ?? 0);
      const segText = String(s.text || s.transcript || "").trim();
      if (segText) {
        speakerSegments.push({ speakerLabel: label, start, end, text: segText });
      }
    }
  }

  // Coach-speaker heuristic: if no explicit diarization, infer from segments
  if (speakerSegments.length === 0 && segments.length > 0) {
    for (const seg of segments) {
      const isCoach = seg.text.length > 20 && /(come on|let's|go to|move|position|defense|attack|hustle|set up|spread out)/i.test(seg.text);
      speakerSegments.push({
        speakerLabel: isCoach ? "coach" : "unknown",
        start: seg.start,
        end: seg.end,
        text: seg.text,
      });
    }
  }

  return { transcript: text, segments, words, speakerSegments };
}

async function extractAudioToWav(videoPath: string, audioPath: string): Promise<void> {
  const AUDIO_TIMEOUT_MS = 300_000; // 5 minutes

  return new Promise((resolve, reject) => {
    const proc = spawn("nice", ["-n", "10", "ffmpeg", ...[
      "-i", videoPath,
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      "-y",
      audioPath,
    ]]);
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Audio extraction timed out after ${AUDIO_TIMEOUT_MS}ms`));
    }, AUDIO_TIMEOUT_MS);
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Audio extraction failed: ${stderr.slice(-500)}`));
    });
  });
}

// ── Audio score computation with speaker-aware weighting (S1-02) ──
function computeAudioScore(
  transcript: string,
  segments: Array<{ start: number; end: number; text: string }>,
  keywords: string[],
  speakerSegments?: Array<{ speakerLabel: string; start: number; end: number; text: string }>,
): { audioScore: number; keywordHits: string[]; hasCoachSpeech: boolean } {
  const lower = transcript.toLowerCase();
  const hits: string[] = [];
  let keywordCount = 0;

  for (const kw of keywords) {
    const regex = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = lower.match(regex);
    if (matches) {
      hits.push(kw);
      keywordCount += matches.length;
    }
  }

  // Speech density
  const totalSpeech = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const totalDuration = segments.length > 0 ? segments[segments.length - 1].end : 1;
  const density = Math.min(totalSpeech / Math.max(totalDuration, 1), 1);

  // Speaker-aware keyword weighting: coach-identified segments count 2×
  let weightedKeywordCount = keywordCount;
  if (speakerSegments && speakerSegments.length > 0) {
    for (const seg of speakerSegments) {
      const segLower = seg.text.toLowerCase();
      const isCoach = seg.speakerLabel.toLowerCase() === "coach";
      for (const kw of keywords) {
        const regex = new RegExp(`\\b${kw}\\b`, "gi");
        const segMatches = segLower.match(regex);
        if (segMatches && isCoach) {
          weightedKeywordCount += segMatches.length; // extra +1× on top of base
        }
      }
    }
  }

  const keywordScore = Math.min(weightedKeywordCount * 8, 60);
  const densityBonus = density * 25;
  const score = Math.max(0, Math.min(100, keywordScore + densityBonus));

  // Coach speech heuristic: long continuous segments with directive words
  const hasCoachSpeech = segments.some(
    (s) => s.text.length > 20 && /(come on|let's|go to|move|position|defense|attack)/i.test(s.text)
  );

  return { audioScore: Math.round(score), keywordHits: hits, hasCoachSpeech };
}

// ── Keyframe extraction (scene-cut aware) ──
async function detectSceneChanges(videoPath: string): Promise<number[]> {
  const SCENE_TIMEOUT_MS = 300_000; // 5 minutes

  return new Promise((resolve) => {
    const proc = spawn("nice", ["-n", "10", "ffmpeg", ...[
      "-i", videoPath,
      "-vf", "select='gt(scene,0.2)',showinfo",
      "-an", "-f", "null", "-",
    ]]);
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve([]);
    }, SCENE_TIMEOUT_MS);
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", () => {
      clearTimeout(timer);
      const timestamps: number[] = [];
      const regex = /pts_time:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (!isNaN(t)) timestamps.push(t);
      }
      resolve(timestamps);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

async function extractKeyframes(
  videoPath: string,
  outputDir: string,
  maxFrames: number,
  duration: number
): Promise<string[]> {
  // 1. Detect scene changes for smarter frame selection
  const sceneChanges = await detectSceneChanges(videoPath);

  // 2. Build frame timestamps: scene changes + midpoints between scenes
  let timestamps: number[] = [];
  if (sceneChanges.length >= 2 && sceneChanges.length <= maxFrames * 2) {
    // Use scene changes + midpoints for action clips
    for (let i = 0; i < sceneChanges.length; i++) {
      timestamps.push(sceneChanges[i]);
      if (i < sceneChanges.length - 1) {
        const midpoint = (sceneChanges[i] + sceneChanges[i + 1]) / 2;
        timestamps.push(midpoint);
      }
    }
  } else if (sceneChanges.length > 0) {
    // Too many scene changes — pick evenly from the scene change list
    const step = sceneChanges.length / maxFrames;
    for (let i = 0; i < maxFrames; i++) {
      timestamps.push(sceneChanges[Math.floor(i * step)]);
    }
  } else {
    // No scene changes (static/speech clip) — evenly spaced
    const interval = duration / (maxFrames + 1);
    for (let i = 1; i <= maxFrames; i++) {
      timestamps.push(interval * i);
    }
  }

  // 3. Deduplicate and sort
  timestamps = Array.from(new Set(timestamps.map((t) => Math.round(t * 100) / 100))).sort((a, b) => a - b);

  // 4. Extract frames
  const paths: string[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const outPath = join(outputDir, `frame_${i}.jpg`);
    const FRAME_TIMEOUT_MS = 60_000; // 1 minute per frame
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("nice", ["-n", "10", "ffmpeg", ...[
        "-ss", time.toFixed(3),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "2",
        "-y",
        outPath,
      ]]);
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Keyframe extraction timed out at ${time}s`));
      }, FRAME_TIMEOUT_MS);
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Keyframe extraction failed at ${time}s`));
      });
    });
    paths.push(outPath);
  }

  return paths;
}

export async function analyzeKeyframesWithVision(
  framePaths: string[],
  sport: string
): Promise<{
  momentScore: number;
  productionScore: number;
  visionFailedBatches: number;
  visionUsedFallback: boolean;
}> {
  const SYSTEM_PROMPT = `You are a sports media evaluator for Girls In Sports.
Analyze the provided keyframes from a youth sports video clip.
Return ONLY a valid JSON object with these two fields:
- momentScore (0-100): Rate the CAPTURED MOMENT. Consider: faces visible, emotion present, sports action happening, story being told, energy level, peak action captured. This is about WHAT the clip captured, not how pretty it looks.
- productionScore (0-100): Rate the TECHNICAL QUALITY. Consider: camera stability, lighting quality, exposure, framing, noise/grain, focus sharpness, color balance. This is about HOW the clip looks.

Return ONLY the JSON object, no markdown, no explanations.`;

  // Read frames in batches of 3
  const batchSize = 3;
  const momentScores: number[] = [];
  const productionScores: number[] = [];
  let visionFailedBatches = 0;
  let visionUsedFallback = false;

  for (let i = 0; i < framePaths.length; i += batchSize) {
    const batch = framePaths.slice(i, i + batchSize);
    const images = batch.map((p) => {
      const buf = readFileSync(p);
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    });

    const content: any[] = [
      { type: "text", text: `Analyze ${batch.length} keyframes from a ${sport} clip. Return JSON with momentScore and productionScore only.` },
    ];
    for (const img of images) {
      content.push({ type: "image_url", image_url: { url: img } });
    }

    const res = await fetch(`${VENICE_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        max_tokens: 300,
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      visionFailedBatches++;
      visionUsedFallback = true;
      const log = createLogger({ stage: "SCORE_CLIP_VISION" });
      log.warn({ batch: i / batchSize, status: res.status }, "Vision API error — using fallback scores");
      continue;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

      momentScores.push(Math.min(100, Math.max(0, Number(parsed.momentScore) || 50)));
      productionScores.push(Math.min(100, Math.max(0, Number(parsed.productionScore) || 40)));
    } catch (e) {
      const log = createLogger({ stage: "SCORE_CLIP_VISION" });
      log.warn({ rawPreview: raw.slice(0, 200) }, "Failed to parse vision response — degraded quality");
      visionUsedFallback = true;
      momentScores.push(50);
      productionScores.push(40);
    }
  }

  const avgMoment = momentScores.length > 0
    ? momentScores.reduce((a, b) => a + b, 0) / momentScores.length : 50;
  const avgProduction = productionScores.length > 0
    ? productionScores.reduce((a, b) => a + b, 0) / productionScores.length : 40;

  return {
    momentScore: Math.round(avgMoment),
    productionScore: Math.round(avgProduction),
    visionFailedBatches,
    visionUsedFallback,
  };
}

// ── Motion score via ffmpeg scene density ──
async function computeMotionScore(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-i", videoPath,
      "-vf", "select='gt(scene,0.05)',showinfo",
      "-an", "-f", "null", "-",
    ]);

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", () => {
      const timestamps: number[] = [];
      const regex = /pts_time:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (!isNaN(t)) timestamps.push(t);
      }

      // Get duration for normalization
      const durProc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ]);
      let durOut = "";
      durProc.stdout.on("data", (d) => { durOut += d; });
      durProc.on("close", () => {
        const duration = parseFloat(durOut.trim()) || 1;
        const changesPerSecond = timestamps.length / duration;
        const score = Math.min(100, changesPerSecond * 100);
        resolve(Math.round(score));
      });
      durProc.on("error", () => resolve(50));
    });
    proc.on("error", () => resolve(50));
  });
}

// ── Clip type assignment ──
function assignClipType(motionScore: number, audioScore: number): ClipType {
  if (motionScore > 60 && audioScore < 40) return ClipType.ACTION;
  if (audioScore > 60 && motionScore < 40) return ClipType.SPEECH;
  if (motionScore > 60 && audioScore > 40) return ClipType.MIXED;
  return ClipType.MONTAGE;
}

// ── Cut a temporal window from a source (for legacy child CLIP scene re-scoring) ──
async function cutWindow(
  sourcePath: string,
  outputPath: string,
  start: number,
  end: number
): Promise<void> {
  const CUT_TIMEOUT_MS = 120_000;
  return new Promise((resolve, reject) => {
    const proc = spawn("nice", ["-n", "10", "ffmpeg", ...[
      "-ss", start.toFixed(3),
      "-to", end.toFixed(3),
      "-i", sourcePath,
      "-c", "copy",
      "-y",
      outputPath,
    ]]);
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`ffmpeg window cut timed out after ${CUT_TIMEOUT_MS}ms`));
    }, CUT_TIMEOUT_MS);
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg window cut failed: ${stderr.slice(-500)}`));
      } else {
        resolve();
      }
    });
  });
}
