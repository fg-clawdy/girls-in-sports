import { PrismaClient, AssetStatus, AssetTagSource, ClipType } from "@prisma/client";
import { spawnLimitedFfmpeg, spawnLimitedFfprobe } from "../ffmpeg-utils";
import { promises as fs, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "../prisma";
import { downloadAssetToFile, updateAssetDescription } from "../immich";
import { computeTieredScore, TIER_FORMULAS } from "../tier-formulas";
import { checkAndReserveBudget, isEventCircuitPaused, recordJobOutcome, refundBudget, estimateScoreClipCost } from "../cost-estimator";
import { transcribeVideo, TranscriptionResult } from "../transcription";
// US-014: centralized quality flag + error recording (graceful degradation, circuit breaker, user-visible messages)
import { createLogger } from "../logger";
import { recordQualityFlags, markPartialSuccess, recordJobError } from "./quality-tracking";
// S1-06: AI interestingness — temporal window scoring + quote quality analysis
import {
  analyzeTemporalInterestingness,
  analyzeQuoteQuality,
  buildSegmentsFromWindows,
  buildSegmentsFromQuotes,
} from "../ai-interestingness";

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

// S1-06: Feature flag — disable AI interestingness entirely for emergencies
const ENABLE_AI_INTERESTINGNESS = process.env.AI_INTERESTINGNESS_ENABLED !== "false";

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
  let interestingnessFailed = false;
  let quotesFailed = false;

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
    const eventName = asset.event?.name || "Unknown Event";

    // US-003/005: transitional — read activityTags from event, fallback to sport inference
    let activityTags: import("../activity-tags").ActivityTag[] = (asset.event?.activityTags as any) ?? [];
    if (activityTags.length === 0) {
      // Fallback inference from sport (deprecated — will be removed after UI adoption)
      if (sport !== "default") {
        activityTags = ["sports"];
      }
    }

    // ── 2. Run STT on raw video (dual-path: Venice beta with diarization primary, Whisper fallback)
    let sttResult: TranscriptionResult;
    const existingWords = (asset as any).transcriptWordsJson;
    if (existingWords && Array.isArray(existingWords) && existingWords.length > 0) {
      const words = existingWords.map((w: any) => ({
        word: String(w.word || ""),
        start: Number(w.startMs ?? 0) / 1000,
        end: Number(w.endMs ?? 0) / 1000,
        speakerLabel: w.speakerLabel ? String(w.speakerLabel) : undefined,
      }));
      const transcript = words.map((w: any) => w.word).join(" ");
      const segments: Array<{ start: number; end: number; text: string }> = [];
      let cur: typeof words = [];
      for (const w of words) {
        if (cur.length === 0) { cur.push(w); continue; }
        const last = cur[cur.length - 1];
        if (w.start - last.end > 1.5 || cur.length >= 12) {
          segments.push({
            start: cur[0].start,
            end: last.end,
            text: cur.map((cw: any) => cw.word).join(" "),
          });
          cur = [w];
        } else {
          cur.push(w);
        }
      }
      if (cur.length > 0) {
        segments.push({
          start: cur[0].start,
          end: cur[cur.length - 1].end,
          text: cur.map((cw: any) => cw.word).join(" "),
        });
      }
      const speakerSegs: Array<{ speakerLabel: string; start: number; end: number; text: string }> = [];
      const groupedBySpeaker = new Map<string, typeof words>();
      for (const w of words) {
        const spk = w.speakerLabel || "unknown";
        if (!groupedBySpeaker.has(spk)) groupedBySpeaker.set(spk, []);
        groupedBySpeaker.get(spk)!.push(w);
      }
      for (const [label, ws] of Array.from(groupedBySpeaker.entries())) {
        if (ws.length === 0) continue;
        speakerSegs.push({
          speakerLabel: label,
          start: ws[0].start,
          end: ws[ws.length - 1].end,
          text: ws.map((w: any) => w.word).join(" "),
        });
      }
      sttResult = {
        transcript,
        segments,
        words,
        speakerSegments: speakerSegs,
        provider: "venice-beta",
      };
    } else {
      sttResult = await transcribeVideo(analysisPath);
      if (sttResult.words.length > 0) {
        await prisma.asset.update({
          where: { id: assetId },
          data: {
            transcriptWordsJson: sttResult.words.map((w) => ({
              word: w.word,
              startMs: Math.round(w.start * 1000),
              endMs: Math.round(w.end * 1000),
            })) as any,
          },
        });
      }
    }
    const { transcript, segments: sttSegments, words, speakerSegments, provider } = sttResult;

    // ── 3. Compute audio/keyword score (speaker-aware) ──
    const keywords = SPORT_KEYWORDS[sport] || SPORT_KEYWORDS.default;
    const { audioScore, keywordHits, hasCoachSpeech } = computeAudioScore(
      transcript,
      sttSegments,
      keywords,
      speakerSegments,
    );

    // ── 4. Compute motion score EARLY (for clipType + dynamic frame strategy) ──
    const motionScore = await computeMotionScore(analysisPath);

    // ── S1-05: Audio signal rescue ──
    const { hasCrowdRoar, roarScore } = await detectCrowdRoar(analysisPath);

    // ── S1-05: Clip type assignment ──
    let clipType = assignClipType(motionScore, audioScore);
    let audioSignalRescue = false;
    if (motionScore < 30 && (audioScore > 50 || hasCrowdRoar)) {
      audioSignalRescue = true;
      if (clipType !== ClipType.SPEECH && clipType !== ClipType.MIXED) {
        clipType = ClipType.MIXED;
      }
    }

    // ── 6. Content-aware dynamic frame sampling (S1-04) ──
    const MAX_FRAMES_PER_CLIP = parseInt(process.env.MAX_FRAMES_PER_CLIP || "120", 10);
    const fps = (clipType === ClipType.ACTION || clipType === ClipType.MIXED) ? 3 : 1;
    const rawFrameCount = Math.ceil(analysisDuration * fps);
    const frameCount = Math.min(rawFrameCount, MAX_FRAMES_PER_CLIP);
    const interval = frameCount < rawFrameCount ? analysisDuration / frameCount : 1 / fps;

    const framesDir = join(tmpDir, "frames");
    await fs.mkdir(framesDir, { recursive: true });
    const framePaths = await extractKeyframes(analysisPath, framesDir, frameCount, interval, analysisDuration);

    // ── 7. Vision analysis on keyframes ──
    let momentScore = 0;
    let productionScore = 0;
    let hasFaces = false;

    if (VENICE_API_KEY && framePaths.length > 0) {
      const visionResults = await analyzeKeyframesWithVision(framePaths, sport);
      momentScore = visionResults.momentScore;
      productionScore = visionResults.productionScore;
      visionFailedBatches = visionResults.visionFailedBatches;
      visionUsedFallback = visionResults.visionUsedFallback;
    }

    // ═══════════════════════════════════════════════════════════════
    // ── 7a. S1-06: AI Temporal Interestingness Analysis ──
    // For continuous cell-phone videos, ffmpeg scene detection doesn't work.
    // Instead, split the video into ~8s windows and use AI vision to score
    // each window for excitement/action/emotion/peak moments.
    // ═══════════════════════════════════════════════════════════════
    let interestingnessResult: Awaited<ReturnType<typeof analyzeTemporalInterestingness>> | null = null;
    let quoteQualityResult: Awaited<ReturnType<typeof analyzeQuoteQuality>> | null = null;

    if (ENABLE_AI_INTERESTINGNESS && VENICE_API_KEY && analysisDuration >= 4) {
      const log = createLogger({ stage: "SCORE_CLIP_AI_INTERESTINGNESS" });

      // Only run on clips that could benefit (not extremely short clips or pure speech)
      const shouldRunInterestingness =
        clipType === ClipType.ACTION || clipType === ClipType.MIXED || clipType === ClipType.MONTAGE;

      if (shouldRunInterestingness) {
        try {
          interestingnessResult = await analyzeTemporalInterestingness(
            analysisPath,
            analysisDuration,
            {
              windowDuration: 8,
              framesPerWindow: 3,
              maxWindows: Math.min(40, Math.ceil(analysisDuration / 8)),
              activityTags,
            }
          );
          log.info({
            avgInterestingness: interestingnessResult.averageInterestingness,
            topWindows: interestingnessResult.topWindowIndices,
            apiCalls: interestingnessResult.totalApiCalls,
            failed: interestingnessResult.failedApiCalls,
          }, "Temporal interestingness analysis complete");
        } catch (err) {
          interestingnessFailed = true;
          log.warn({ err }, "Temporal interestingness analysis failed — continuing without it");
        }
      }

      // Run quote quality if we have a transcript with content
      if (transcript.trim().length > 20) {
        try {
          quoteQualityResult = await analyzeQuoteQuality(
            transcript,
            speakerSegments.map((s) => ({ speakerLabel: s.speakerLabel, start: s.start, end: s.end, text: s.text })),
            {
              maxQuotes: 5,
              activityTags,
            }
          );
          log.info({
            quoteCount: quoteQualityResult.quotes.length,
            avgQuality: quoteQualityResult.averageQuoteQuality,
            model: quoteQualityResult.modelUsed,
          }, "Quote quality analysis complete");
        } catch (err) {
          quotesFailed = true;
          log.warn({ err }, "Quote quality analysis failed — continuing without it");
        }
      }
    }

    // ── 7b. S1-06: Create child CLIP assets from interestingness windows ──
    // Top windows are extracted as child Asset(type=CLIP) entries so the campaign
    // composer can select specific high-interest moments rather than whole clips.
    if (interestingnessResult && interestingnessResult.windows.length > 0) {
      const topSegments = buildSegmentsFromWindows(interestingnessResult.windows, {
        threshold: 50,
        maxSegments: 5,
        mergeGap: 3,
      });

      for (const seg of topSegments) {
        const offsetMs = needsWindow ? Math.round(winStart * 1000) : 0;
        const childStartMs = offsetMs + Math.round(seg.startTime * 1000);
        const childEndMs = offsetMs + Math.round(seg.endTime * 1000);

        // Idempotency: skip if a child CLIP already exists for this time window
        const exists = await prisma.asset.findFirst({
          where: {
            parentAssetId: assetId,
            type: "CLIP",
            startTimeMs: childStartMs,
            endTimeMs: childEndMs,
          },
        });
        if (exists) continue;

        await prisma.asset.create({
          data: {
            eventId,
            type: "CLIP",
            parentAssetId: assetId,
            immichAssetId, // same parent video reference
            startTimeMs: childStartMs,
            endTimeMs: childEndMs,
            status: "UPLOADED", // will be scored separately if needed
            motionLevel: "HIGH",
            dominantMode: "ACTION",
          },
        });
      }
    }

    // ── 7c. S1-06: Create child CLIP assets for top quotes ──
    if (quoteQualityResult && quoteQualityResult.quotes.length > 0) {
      const quoteSegments = buildSegmentsFromQuotes(quoteQualityResult.quotes, {
        threshold: 60,
        maxSegments: 4,
        padSeconds: 2,
      });

      for (const qs of quoteSegments) {
        const offsetMs = needsWindow ? Math.round(winStart * 1000) : 0;
        const childStartMs = offsetMs + Math.round(qs.startTime * 1000);
        const childEndMs = offsetMs + Math.round(qs.endTime * 1000);

        // Idempotency: skip if a child CLIP already exists for this time window
        const exists = await prisma.asset.findFirst({
          where: {
            parentAssetId: assetId,
            type: "CLIP",
            startTimeMs: childStartMs,
            endTimeMs: childEndMs,
          },
        });
        if (exists) continue;

        await prisma.asset.create({
          data: {
            eventId,
            type: "CLIP",
            parentAssetId: assetId,
            immichAssetId,
            startTimeMs: childStartMs,
            endTimeMs: childEndMs,
            status: "UPLOADED",
            motionLevel: "LOW",
            dominantMode: "SPEECH",
          },
        });
      }
    }

    // ── 8. Tiered compositeScore ──
    const eventTier = asset.event?.qualityTier ?? "PROFESSIONAL";
    let finalComposite = 0;
    if (clipType === ClipType.SPEECH) {
      finalComposite = Math.round(audioScore * 0.7 + productionScore * 0.3);
    } else {
      const tierResult = computeTieredScore(momentScore, productionScore, eventTier);
      finalComposite = tierResult.combined;
    }

    // ── 9. Upsert ClipScore record (allows re-runs) ──
    const speakerSegmentsJson = speakerSegments.length > 0 ? speakerSegments : null;
    const interestingnessJson = interestingnessResult?.windows ?? null;
    const quoteScoresJson = quoteQualityResult?.quotes ?? null;

    await prisma.clipScore.upsert({
      where: { assetId },
      create: {
        assetId,
        visionScore: Math.round(productionScore),
        audioScore: Math.round(audioScore),
        motionScore: Math.round(motionScore),
        momentScore,
        productionScore,
        compositeScore: finalComposite,
        clipType,
        hasFaces,
        hasCoachSpeech,
        hasActionKeyword: keywordHits.some((k) =>
          ["shoot", "shot", "goal", "score", "spike", "block", "save", "tackle"].includes(k)
        ),
        hasCrowdRoar,
        audioSignalRescue,
        transcriptExcerpt: transcript.slice(0, 200),
        keywordHits: JSON.stringify(keywordHits),
        transcriptionProvider: provider,
        speakerSegmentsJson: speakerSegmentsJson as any,
        interestingnessJson: interestingnessJson as any,
        quoteScoresJson: quoteScoresJson as any,
      },
      update: {
        visionScore: Math.round(productionScore),
        audioScore: Math.round(audioScore),
        motionScore: Math.round(motionScore),
        momentScore,
        productionScore,
        compositeScore: finalComposite,
        clipType,
        hasFaces,
        hasCoachSpeech,
        hasActionKeyword: keywordHits.some((k) =>
          ["shoot", "shot", "goal", "score", "spike", "block", "save", "tackle"].includes(k)
        ),
        hasCrowdRoar,
        audioSignalRescue,
        transcriptExcerpt: transcript.slice(0, 200),
        keywordHits: JSON.stringify(keywordHits),
        transcriptionProvider: provider,
        speakerSegmentsJson: speakerSegmentsJson as any,
        interestingnessJson: interestingnessJson as any,
        quoteScoresJson: quoteScoresJson as any,
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
      `gis:score=${finalComposite}`,
      `gis:type=${clipType}`,
      `gis:sport=${eventSport}`,
      `gis:hasFaces=${hasFaces}`,
      `gis:hasCoachSpeech=${hasCoachSpeech}`,
      `gis:hasCrowdRoar=${hasCrowdRoar}`,
      `gis:audioSignalRescue=${audioSignalRescue}`,
    ].join("\n");

    await updateAssetDescription(immichAssetId, tagDescription);

    const tagsToWrite = [
      { tag: `score:${finalComposite}`, confidence: 1.0 },
      { tag: `type:${clipType}`, confidence: 1.0 },
      { tag: `sport:${eventSport}`, confidence: 1.0 },
      ...(hasFaces ? [{ tag: "hasFaces", confidence: 1.0 }] : []),
      ...(hasCoachSpeech ? [{ tag: "hasCoachSpeech", confidence: 1.0 }] : []),
      ...(hasCrowdRoar ? [{ tag: "hasCrowdRoar", confidence: 1.0 }] : []),
      ...(audioSignalRescue ? [{ tag: "audioSignalRescue", confidence: 1.0 }] : []),
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
    await recordQualityFlags(args.jobId, "score-clip", {
      visionFailedBatches,
      visionUsedFallback,
      interestingnessFailed,
      quotesFailed,
      interestingnessApiCalls: interestingnessResult?.totalApiCalls ?? 0,
      interestingnessFailures: interestingnessResult?.failedApiCalls ?? 0,
      sttFailed: false,
      transcriptionProvider: provider,
    });
  } catch (err) {
    await recordJobError(args.jobId, err as Error, "score-clip");
    throw err;
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
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

  const totalSpeech = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const totalDuration = segments.length > 0 ? segments[segments.length - 1].end : 1;
  const density = Math.min(totalSpeech / Math.max(totalDuration, 1), 1);

  let weightedKeywordCount = keywordCount;
  if (speakerSegments && speakerSegments.length > 0) {
    for (const seg of speakerSegments) {
      const segLower = seg.text.toLowerCase();
      const isCoach = seg.speakerLabel.toLowerCase() === "coach";
      for (const kw of keywords) {
        const regex = new RegExp(`\\b${kw}\\b`, "gi");
        const segMatches = segLower.match(regex);
        if (segMatches && isCoach) {
          weightedKeywordCount += segMatches.length;
        }
      }
    }
  }

  const keywordScore = Math.min(weightedKeywordCount * 8, 60);
  const densityBonus = density * 25;
  const score = Math.max(0, Math.min(100, keywordScore + densityBonus));

  const hasCoachSpeech = segments.some(
    (s) => s.text.length > 20 && /(come on|let's|go to|move|position|defense|attack)/i.test(s.text)
  );

  return { audioScore: Math.round(score), keywordHits: hits, hasCoachSpeech };
}

// ── Keyframe extraction (scene-cut aware) ──
async function detectSceneChanges(videoPath: string): Promise<number[]> {
  const SCENE_TIMEOUT_MS = 300_000;

  const { proc } = spawnLimitedFfmpeg([
    "-i", videoPath,
    "-vf", "select='gt(scene,0.2)',showinfo",
    "-an", "-f", "null", "-",
  ], { nice: 15, timeoutMs: SCENE_TIMEOUT_MS, logTag: "score-clip:detectSceneChanges" });

  return new Promise((resolve) => {
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", () => {
      const timestamps: number[] = [];
      const regex = /pts_time:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (!isNaN(t)) timestamps.push(t);
      }
      resolve(timestamps);
    });
    proc.on("error", () => resolve([]));
  });
}

async function extractKeyframes(
  videoPath: string,
  outputDir: string,
  maxFrames: number,
  interval: number,
  duration: number
): Promise<string[]> {
  const sceneChanges = await detectSceneChanges(videoPath);

  let timestamps: number[] = [];
  if (sceneChanges.length >= 2 && sceneChanges.length <= maxFrames * 2) {
    for (let i = 0; i < sceneChanges.length; i++) {
      timestamps.push(sceneChanges[i]);
      if (i < sceneChanges.length - 1) {
        const midpoint = (sceneChanges[i] + sceneChanges[i + 1]) / 2;
        timestamps.push(midpoint);
      }
    }
  } else if (sceneChanges.length > 0) {
    const step = sceneChanges.length / maxFrames;
    for (let i = 0; i < maxFrames; i++) {
      timestamps.push(sceneChanges[Math.floor(i * step)]);
    }
  } else {
    for (let i = 0; i < maxFrames; i++) {
      timestamps.push(interval * i + interval / 2);
    }
  }

  timestamps = Array.from(new Set(timestamps.filter((t) => t < duration).map((t) => Math.round(t * 100) / 100))).sort((a, b) => a - b);

  const paths: string[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const outPath = join(outputDir, `frame_${i}.jpg`);
    const FRAME_TIMEOUT_MS = 60_000;
    const { proc } = spawnLimitedFfmpeg([
      "-ss", time.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      "-y",
      outPath,
    ], { nice: 15, timeoutMs: FRAME_TIMEOUT_MS, logTag: "score-clip:extractKeyframes" });
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Keyframe extraction failed at ${time}s`));
      });
      proc.on("error", reject);
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

  const batchSize = 6;
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

    const ac = new AbortController();
    const visionTimeout = setTimeout(() => ac.abort(), 120_000);
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
      signal: ac.signal,
    });
    clearTimeout(visionTimeout);

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
  const MOTION_TIMEOUT_MS = 120_000;
  const { proc } = spawnLimitedFfmpeg([
    "-i", videoPath,
    "-vf", "select='gt(scene,0.05)',showinfo",
    "-an", "-f", "null", "-",
  ], { nice: 15, timeoutMs: MOTION_TIMEOUT_MS, logTag: "score-clip:computeMotionScore" });

  return new Promise((resolve) => {
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", () => {
      const timestamps: number[] = [];
      const regex = /pts_time:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (!isNaN(t)) timestamps.push(t);
      }

      const { proc: durProc } = spawnLimitedFfprobe([
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ], { logTag: "score-clip:computeMotionScore:ffprobe" });
      let durOut = "";
      durProc.stdout?.on("data", (d: Buffer) => { durOut += d.toString(); });
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

// ── S1-05: Crowd roar / celebration detection via audio energy peaks ──
async function detectCrowdRoar(
  videoPath: string
): Promise<{ hasCrowdRoar: boolean; roarScore: number }> {
  const ROAR_TIMEOUT_MS = 60_000;
  return new Promise((resolve) => {
    const { proc } = spawnLimitedFfmpeg([
      "-i", videoPath,
      "-af", "asetnsamples=n=16000,volumedetect",
      "-f", "null", "-",
    ], { nice: 15, timeoutMs: ROAR_TIMEOUT_MS, logTag: "score-clip:detectCrowdRoar" });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", () => {
      const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
      if (!meanMatch || !maxMatch) {
        resolve({ hasCrowdRoar: false, roarScore: 0 });
        return;
      }
      const meanVol = parseFloat(meanMatch[1]);
      const maxVol = parseFloat(maxMatch[1]);
      const hasCrowdRoar = meanVol > -15 || maxVol > -3;
      const roarScore = Math.min(100, Math.round(
        Math.max(0, (meanVol + 40) * 2.5)
      ));
      resolve({ hasCrowdRoar, roarScore });
    });
    proc.on("error", () => resolve({ hasCrowdRoar: false, roarScore: 0 }));
  });
}

// ── Cut a temporal window from a source ──
async function cutWindow(
  sourcePath: string,
  outputPath: string,
  start: number,
  end: number
): Promise<void> {
  const CUT_TIMEOUT_MS = 120_000;
  const { proc } = spawnLimitedFfmpeg([
    "-ss", start.toFixed(3),
    "-to", end.toFixed(3),
    "-i", sourcePath,
    "-c", "copy",
    "-y",
    outputPath,
  ], { nice: 15, timeoutMs: CUT_TIMEOUT_MS, logTag: "score-clip:cutWindow" });

  return new Promise((resolve, reject) => {
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg window cut failed: ${stderr.slice(-500)}`));
      } else {
        resolve();
      }
    });
    proc.on("error", reject);
  });
}