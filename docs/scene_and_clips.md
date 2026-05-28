# Scene Detection & Clip Creation — Technical Deep Dive

**Version:** 2.0  
**Date:** 2026-05-27  
**Project:** Girls In Sports — AI Highlight Engine

---

## Table of Contents

1. [Overview & Architecture](#1-overview--architecture)
2. [Data Model](#2-data-model)
3. [Stage 1: INGEST_CLIP — Ingestion & Segmentation](#3-stage-1-ingest_clip--ingestion--segmentation)
4. [Stage 2: SCORE_CLIP — Per-Clip Scoring](#4-stage-2-score_clip--per-clip-scoring)
5. [Scene Detection: The Core Algorithm](#5-scene-detection-the-core-algorithm)
6. [AI Temporal Interestingness (S1-06)](#6-ai-temporal-interestingness-s1-06)
7. [Clip Type Classification](#7-clip-type-classification)
8. [Dynamic Frame Sampling (S1-04)](#8-dynamic-frame-sampling-s1-04)
9. [Audio Analysis & Crowd Roar Detection](#9-audio-analysis--crowd-roar-detection)
10. [Vision Scoring](#10-vision-scoring)
11. [Child Assets & Scene Hierarchy](#11-child-assets--scene-hierarchy)
12. [Render Pipeline: Resolving Scene Cuts for Final Output](#12-render-pipeline-resolving-scene-cuts-for-final-output)
13. [Job Orchestration & State Machine](#13-job-orchestration--state-machine)
14. [End-to-End Data Flow Diagram](#14-end-to-end-data-flow-diagram)
15. [Referenced Files](#15-referenced-files)

---

## 1. Overview & Architecture

The scene detection and clip creation system takes raw sports video uploads (typically continuous cell-phone recordings of youth sports events) and decomposes them into discrete, scored highlight clips. These clips are then available for the campaign composer to assemble into highlight reels.

**Key design principle:** Traditional ffmpeg scene detection (looking for visual cuts/transitions) does **not** work on continuous cell-phone video because the camera never stops rolling. Instead, GIS uses a multi-signal approach combining:

- **Motion analysis** — ffmpeg scene-filter density scoring to find natural action boundaries
- **Speech/transcript analysis** — word-level STT timestamps to find sentence boundaries and speaker transitions
- **Silence gap detection** — audio energy analysis to find natural breaks between plays
- **I-frame snapping** — ffmpeg keyframe detection to ensure clean cuts at GOP boundaries
- **AI temporal interestingness** — Venice Vision LLM evaluating temporal windows for excitement, action, emotion, and peak moments
- **AI quote quality** — Text LLM identifying the most quotable/memorable lines from transcripts

The pipeline is entirely asynchronous, driven by a BullMQ-backed job queue with PostgreSQL as the source of truth.

---

## 2. Data Model

### Core Entities

```
Event ──< Asset ──< ClipScore
  │         │
  │         └── AssetTag
  │
  └──< Campaign ──< CampaignClip
                    │
                    └── Asset (via assetId)
```

### Asset Hierarchy (Parent-Child)

Assets use a self-referencing tree structure:

```
Asset (type=SOURCE_VIDEO, parentAssetId=null)     ← original upload
  ├── Asset (type=CLIP, parentAssetId=source.id)   ← segment 1 (startTimeMs/endTimeMs)
  ├── Asset (type=CLIP, parentAssetId=source.id)   ← segment 2
  ├── Asset (type=CLIP, parentAssetId=source.id)   ← segment 3
  └── Asset (type=CLIP, parentAssetId=seg2.id)     ← sub-clip from interestingness/quote
```

Two kinds of child CLIP assets exist:

1. **Segmentation CLIPs** — created during `INGEST_CLIP` by `video-segmentation.ts`. These decompose the full source video into meaningful segments (one play = one clip).
2. **Interestingness/Quote CLIPs** — created during `SCORE_CLIP` by `ai-interestingness.ts`. These extract the most exciting ~8s windows or quotable speech moments from an already-segmented clip.

### Key Schema Models

**Asset** (`prisma/schema.prisma` lines 33–65):
```prisma
model Asset {
  id                String         @id @default(cuid())
  eventId           String
  immichAssetId     String?
  type              AssetType      // SOURCE_VIDEO | CLIP | PROXY | FINAL
  parentAssetId     String?        // self-referencing for clip hierarchy
  startTimeMs       Int?           // for CLIP children: offset into parent video
  endTimeMs         Int?
  durationSeconds   Float?
  widthPx           Int?
  heightPx          Int?
  fps               Float?
  codec             String?
  status            AssetStatus    // UPLOADED → INGESTING → SCORED | FAILED
  motionLevel       String?        // LOW | MEDIUM | HIGH
  dominantMode      String?        // ACTION | SPEECH | MIXED
  transcriptWordsJson Json?        // word-level STT: [{word, startMs, endMs, speakerLabel?}]
  parentAsset       Asset?         @relation("AssetParent", ...)
  childAssets       Asset[]        @relation("AssetParent")
  clipScore         ClipScore?
}
```

**ClipScore** (`prisma/schema.prisma` lines 67–95):
```prisma
model ClipScore {
  id                  String    @id
  assetId             String    @unique
  visionScore         Float?
  audioScore          Float?
  motionScore         Float?
  compositeScore      Float?
  clipType            ClipType?   // ACTION | SPEECH | MIXED | MONTAGE
  hasFaces            Boolean
  hasCoachSpeech      Boolean
  hasActionKeyword    Boolean
  hasCrowdRoar        Boolean     // S1-05
  audioSignalRescue   Boolean     // S1-05
  transcriptExcerpt   String?
  keywordHits         Json?
  transcriptionProvider String?
  speakerSegmentsJson   Json?     // [{speakerLabel, start, end, text}]
  interestingnessJson  Json?      // S1-06: temporal window scores
  quoteScoresJson      Json?      // S1-06: quotable moments
  momentScore         Float?
  productionScore     Float?
}
```

**Job** (`prisma/schema.prisma` lines 302–323):
```prisma
model Job {
  id            String    @id
  type          JobType     // INGEST_CLIP | SCORE_CLIP | DIRECT_SCRIPT | RENDER_PROXY | RENDER_FINAL | ...
  status        JobStatus   // QUEUED → RUNNING → DONE | FAILED | RETRYING
  payload       Json?
  attempts      Int       @default(0)
  maxAttempts   Int       @default(3)
  error         String?
  qualityFlags  Json?       // structured partial-failure details
  retryAfter    DateTime?
  parentJobId   String?     // for SCORE_CLIP parented under INGEST_CLIP
}
```

**SceneSegment** (deprecated — `prisma/schema.prisma` lines 212–227):
```prisma
// DEPRECATED (US-008): Legacy scene storage.
// All new scenes use child Asset(type=CLIP) with parentAssetId + startTimeMs/endTimeMs.
model SceneSegment {
  id          String   @id
  parentId    String
  eventId     String
  startTime   Float
  endTime     Float
  duration    Float
  motionScore Float
}
```

---

## 3. Stage 1: INGEST_CLIP — Ingestion & Segmentation

**Trigger:** Automatically enqueued after a user uploads media to an event.  
**Handler:** `src/lib/handlers/ingest-clip.ts` → function `handleIngestClip()`  
**Job type:** `JobType.INGEST_CLIP`  
**Concurrency:** 3 (`src/lib/queues.ts`)  
**Timeout:** 10 minutes (`src/lib/job-worker.ts` line 27)

### Pipeline Steps

```
INGEST_CLIP
├── 1. Download source video from Immich into /tmp/gis/ingest/{assetId}/
├── 2. ffprobe metadata extraction (duration, codec, resolution, fps)
│       → src/lib/ffmpeg-utils.ts (spawnLimitedFfprobe)
├── 3. Circuit breaker check: isEventCircuitPaused(eventId)
│       → src/lib/cost-estimator.ts (in-memory failure counter)
├── 4. Budget check: checkAndReserveBudget(eventId, estimatedCost)
│       → src/lib/cost-estimator.ts (atomic DB increment)
├── 5. STT Transcription (dual-path)
│       → src/lib/transcription.ts
│       ├── Primary: Venice diarization API (word-level + speaker labels)
│       └── Fallback: Local Whisper (word-level timestamps only)
├── 6. Store transcript on Asset.transcriptWordsJson
│       → [{word, startMs, endMs, speakerLabel?}]
├── 7. Scene Detection & Segmentation
│       → src/lib/scene-detection-service.ts → analyzeAndSegment()
│       → src/lib/video-segmentation.ts → segmentVideo()
│       (See §5 for full algorithm)
├── 8. Create child CLIP Assets for each segment
│       → INSERT Asset(type=CLIP, parentAssetId=source.id,
│                      startTimeMs, endTimeMs, motionLevel, dominantMode)
├── 9. Enqueue SCORE_CLIP for each child CLIP (with parentJobId)
│       → src/lib/job-worker.ts → enqueueJob(SCORE_CLIP, {assetId, ...})
├── 10. Record quality flags (success/failure per stage)
│        → src/lib/handlers/quality-tracking.ts → recordQualityFlags()
└── 11. Cleanup /tmp/gis/ingest/{assetId}/
```

### Key Code: Enqueuing Score Jobs for Child Clips

From `src/lib/handlers/ingest-clip.ts` (after segmentation):
```typescript
// For each segment, create a child Asset and enqueue SCORE_CLIP
for (const seg of segments) {
  const child = await prisma.asset.create({
    data: {
      eventId,
      type: "CLIP",
      parentAssetId: assetId,
      immichAssetId,              // same parent video — time window defines the clip
      startTimeMs: seg.startTimeMs,
      endTimeMs: seg.endTimeMs,
      status: "UPLOADED",
      motionLevel: seg.motionLevel,   // LOW | MEDIUM | HIGH
      dominantMode: seg.dominantMode, // ACTION | SPEECH | MIXED
    },
  });

  await enqueueJob(JobType.SCORE_CLIP, {
    assetId: child.id,
    immichAssetId,
    eventId,
    parentJobId: dbJobId,         // link to INGEST_CLIP parent job
  });
}
```

### Child Clip vs. Parent Video Resolution

Child CLIP assets share the same `immichAssetId` as their parent `SOURCE_VIDEO`. The clip's time window is defined by `startTimeMs` and `endTimeMs`. During scoring and rendering, the system detects this pattern and extracts only the relevant temporal window:

```typescript
// From score-clip.ts lines 79–95:
if (asset.parentAssetId && asset.startTimeMs != null && asset.endTimeMs != null
    && parentAsset && asset.immichAssetId === parentAsset.immichAssetId) {
  // This is a legacy virtual scene (child shares immich with parent)
  analysisImmich = parentAsset.immichAssetId;
  needsWindow = true;
  winStart = (asset.startTimeMs || 0) / 1000;
  winEnd = (asset.endTimeMs || 0) / 1000;
}
```

---

## 4. Stage 2: SCORE_CLIP — Per-Clip Scoring

**Trigger:** One job per child CLIP asset, enqueued by `INGEST_CLIP`.  
**Handler:** `src/lib/handlers/score-clip.ts` → function `handleScoreClip()`  
**Job type:** `JobType.SCORE_CLIP`  
**Concurrency:** 4 (`src/lib/queues.ts`)  
**Timeout:** 5 minutes (`src/lib/job-worker.ts` line 28)

### Pipeline Steps

```
SCORE_CLIP
├── 1. Download clip from Immich (or cut window from parent)
│       ├── If clip shares immichAssetId with parent: cut window via ffmpeg
│       │     → ffmpeg -ss {winStart} -to {winEnd} -i parent -c copy output
│       └── Otherwise: direct download via downloadAssetToFile()
├── 2. Circuit breaker + budget check
├── 3. STT Transcription (reuse existing or run fresh)
│       → Transforms stored transcriptWordsJson into structured TranscriptionResult
│       → Groups words by speaker label
├── 4. Audio Score Computation
│       → computeAudioScore(transcript, segments, keywords, speakerSegments)
│       → Keyword density × 8 (capped at 60) + speech density bonus (capped at 25)
│       → Coach-speaker keyword weighting (extra weight for coach-uttered action words)
│       → Returns: audioScore (0–100), keywordHits[], hasCoachSpeech
├── 5. Motion Score (ffmpeg scene density)
│       → computeMotionScore(videoPath)
│       → ffmpeg select='gt(scene,0.05),showinfo' → count scene changes
│       → changesPerSecond × 100, capped at 100
├── 6. Crowd Roar Detection (S1-05)
│       → detectCrowdRoar(videoPath)
│       → ffmpeg volumedetect → mean_volume, max_volume
│       → hasCrowdRoar = meanVol > -15 dB OR maxVol > -3 dB
│       → roarScore = (meanVol + 40) × 2.5, capped at 100
├── 7. Clip Type Assignment
│       → assignClipType(motionScore, audioScore) → ACTION | SPEECH | MIXED | MONTAGE
│       → Audio Signal Rescue: low-motion + high-audio/crowd-roar → MIXED
├── 8. Dynamic Frame Sampling (S1-04)
│       → ACTION/MIXED: 3 fps  |  SPEECH/MONTAGE: 1 fps
│       → Capped at MAX_FRAMES_PER_CLIP (default: 120)
├── 9. Keyframe Extraction (scene-cut aware)
│       → extractKeyframes(videoPath, outputDir, frameCount, interval, duration)
│       → ffmpeg scene detection: select='gt(scene,0.2),showinfo'
│       → Strategy: scene changes + midpoints, capped at maxFrames
│       → Fallback: uniform interval sampling
│       → Extracts JPEG frames via ffmpeg -ss {time} -frames:v 1
├── 10. Vision Analysis
│        → analyzeKeyframesWithVision(framePaths, sport)
│        → Batches of 6 frames → Venice Vision LLM
│        → Prompt: Rate momentScore (0–100) and productionScore (0–100)
│        → Fallback scores on API failure: moment=50, production=40
├── 11. AI Temporal Interestingness (S1-06) — see §6
│        → analyzeTemporalInterestingness(videoPath, duration, {windowDuration:8})
│        → analyzeQuoteQuality(transcript, speakerSegments, {maxQuotes:5})
├── 12. Create child CLIP assets from interestingness/quote windows
│        → buildSegmentsFromWindows(windows, {threshold:50, maxSegments:5})
│        → buildSegmentsFromQuotes(quotes, {threshold:60, maxSegments:4})
│        → INSERT Asset(type=CLIP, parentAssetId=scoredClip.id)
├── 13. Tiered Composite Score
│        → For SPEECH: audioScore×0.7 + productionScore×0.3
│        → For others: computeTieredScore(momentScore, productionScore, eventTier)
│        → src/lib/tier-formulas.ts (AMATEUR/INTERMEDIATE/PROFESSIONAL weights)
├── 14. Upsert ClipScore record
│        → Stored fields: visionScore, audioScore, motionScore, momentScore,
│          productionScore, compositeScore, clipType, hasFaces, hasCoachSpeech,
│          hasActionKeyword, hasCrowdRoar, audioSignalRescue, transcriptExcerpt,
│          keywordHits, transcriptionProvider, speakerSegmentsJson,
│          interestingnessJson, quoteScoresJson
├── 15. Update Asset status to SCORED
├── 16. Write tags to Immich + AssetTag table
│        → Tags: score:{value}, type:{clipType}, sport:{name},
│          hasFaces, hasCoachSpeech, hasCrowdRoar, audioSignalRescue,
│          + individual keyword tags at confidence 0.8
├── 17. Auto-thumbnail selection (if no manual thumbnail exists)
│        → Finds highest compositeScore across all event clips
│        → Saves thumbnail to public/thumbnails/{eventId}.jpg
├── 18. Sibling completion check
│        → If all sibling CLIPs scored, set parent SOURCE_VIDEO to SCORED
│        → Send push notification: "Footage Ready"
├── 19. Record quality flags (vision failures, interestingness failures, etc.)
└── 20. Cleanup /tmp/gis/score/{assetId}/
```

### Key Code: Audio Score with Speaker-Aware Weighting

From `src/lib/handlers/score-clip.ts` lines 548–595:
```typescript
function computeAudioScore(
  transcript: string,
  segments: Array<{ start: number; end: number; text: string }>,
  keywords: string[],
  speakerSegments?: Array<{ speakerLabel: string; start: number; end: number; text: string }>,
): { audioScore: number; keywordHits: string[]; hasCoachSpeech: boolean } {
  // Count keyword occurrences
  let keywordCount = 0;
  for (const kw of keywords) {
    const regex = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = transcript.toLowerCase().match(regex);
    if (matches) keywordCount += matches.length;
  }

  // Speech density: talk time / total duration
  const totalSpeech = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const density = Math.min(totalSpeech / Math.max(totalDuration, 1), 1);

  // Coach-speaker bonus: extra weight for coach-uttered keywords
  let weightedKeywordCount = keywordCount;
  for (const seg of speakerSegments) {
    if (seg.speakerLabel.toLowerCase() === "coach") {
      for (const kw of keywords) {
        const segMatches = seg.text.toLowerCase().match(new RegExp(`\\b${kw}\\b`, "gi"));
        if (segMatches) weightedKeywordCount += segMatches.length;
      }
    }
  }

  const keywordScore = Math.min(weightedKeywordCount * 8, 60);
  const densityBonus = density * 25;
  return { audioScore: Math.round(Math.min(100, keywordScore + densityBonus)), keywordHits: hits, hasCoachSpeech };
}
```

### Key Code: Clip Type Assignment & Audio Signal Rescue

From `src/lib/handlers/score-clip.ts` lines 820–825 and 205–212:
```typescript
function assignClipType(motionScore: number, audioScore: number): ClipType {
  if (motionScore > 60 && audioScore < 40) return ClipType.ACTION;
  if (audioScore > 60 && motionScore < 40) return ClipType.SPEECH;
  if (motionScore > 60 && audioScore > 40) return ClipType.MIXED;
  return ClipType.MONTAGE;
}

// Audio Signal Rescue (S1-05):
let audioSignalRescue = false;
if (motionScore < 30 && (audioScore > 50 || hasCrowdRoar)) {
  audioSignalRescue = true;
  if (clipType !== ClipType.SPEECH && clipType !== ClipType.MIXED) {
    clipType = ClipType.MIXED;  // rescue low-motion clips with strong audio
  }
}
```

---

## 5. Scene Detection: The Core Algorithm

**Files:** `src/lib/video-segmentation.ts` + `src/lib/scene-detection-service.ts`

### Algorithm Overview

`video-segmentation.ts` exports `segmentVideo()` which takes a video file path and an array of transcript words. It produces an array of `Segment` objects, each with `startTimeMs`, `endTimeMs`, `motionLevel`, and `dominantMode`.

The algorithm uses a multi-pass approach:

### Pass 1: Motion Scoring via ffmpeg Scene Filter

```
ffmpeg -i video -vf "select='gt(scene,0.05),showinfo" -an -f null -
```

This runs ffmpeg's `scene` filter which computes a histogram difference between consecutive frames. The `gt(scene,0.05)` filter selects frames where the difference exceeds 0.05 (a low threshold tuned for continuous sports video). The `showinfo` filter logs `pts_time` to stderr. By counting timestamps per unit time, the system derives a motion density score.

### Pass 2: Boundary Detection

The system finds boundary points where the motion profile changes tier:
- **LOW → MEDIUM/HIGH transition** = clip start (action beginning)
- **HIGH/MEDIUM → LOW transition** = clip end (action ending)
- These transitions are validated against silence gaps in the audio

### Pass 3: I-Frame Snapping

```
ffmpeg -skip_frame nokey -i video -vsync vfr -f frame2pipe -
```

This extracts all I-frames (keyframes) from the video. Since ffmpeg can only cut cleanly at I-frames (without re-encoding), boundary timestamps are snapped to the nearest I-frame position to ensure clean cuts.

### Pass 4: Speech Refinement

Transcript word timestamps are used to refine boundaries:
- Boundaries should not split a sentence mid-word
- Speaker transitions suggest natural clip boundaries
- Silence gaps (>1.5 seconds between words) suggest natural breaks

### Pass 5: Merge Short Clips

Clips shorter than a minimum duration (configurable, typically 4 seconds) are merged with adjacent clips to avoid creating unusably short segments. The merge direction (left or right) is determined by which adjacent clip has the more similar motion profile.

### Service Layer

`src/lib/scene-detection-service.ts` wraps `segmentVideo()` with:
- Temporary file management (`/tmp/gis/scene-detection/{eventId}/`)
- Immich asset download
- Transcript word extraction from Asset
- Child asset creation and SCORE_CLIP enqueueing
- Quality flag recording
- Event status transitions

### Key Code: Scene Detection Service Entry Point

From `src/lib/scene-detection-service.ts`:
```typescript
export async function analyzeAndSegment(params: {
  assetId: string;
  immichAssetId: string;
  eventId: string;
  transcriptWords?: Array<{ word: string; startMs: number; endMs: number }>;
  jobId: string;
}): Promise<Segment[]> {
  // Download source video
  const videoPath = join(tmpDir, "source");
  await downloadAssetToFile(immichAssetId, videoPath);

  // Run segmentation
  const segments = await segmentVideo(videoPath, transcriptWords || []);

  // Create child CLIP Assets
  for (const seg of segments) {
    await prisma.asset.create({
      data: {
        eventId, type: "CLIP",
        parentAssetId: assetId,
        immichAssetId,
        startTimeMs: seg.startTimeMs,
        endTimeMs: seg.endTimeMs,
        motionLevel: seg.motionLevel,
        dominantMode: seg.dominantMode,
        status: "UPLOADED",
      },
    });
  }
  return segments;
}
```

---

## 6. AI Temporal Interestingness (S1-06)

**File:** `src/lib/ai-interestingness.ts`

This subsystem addresses a fundamental problem with continuous cell-phone sports videos: **ffmpeg scene detection doesn't work** because the camera never stops rolling. There are no visual "cuts" to detect.

### Solution: AI-Powered Temporal Window Scoring

Instead of detecting scene changes, the system:
1. Splits the video into overlapping/non-overlapping **~8-second windows**
2. Extracts **3 evenly-spaced keyframes** per window using ffmpeg
3. Batches **5 windows per API call** (15 images total)
4. Sends each batch to the **Venice Vision LLM** with a specialized prompt

### API Prompt

```
You are a sports video analyst evaluating continuous footage from a youth {sport} game.

You will see groups of 3 frames, each group representing an ~8-second window of continuous video.
For EACH group, assign scores 0-100:

- actionScore: How much physical sports action is visible? (running, shooting, defending, etc.)
- emotionScore: How much visible emotion/excitement? (celebration, intensity, reactions)
- peakMomentScore: Is this capturing a decisive game moment? (score, turnover, big play)

Return JSON: [{windowIndex, actionScore, emotionScore, peakMomentScore, description}]
```

### Interestingness Score Formula

Each window's aggregate `interestingnessScore` is computed as:
```
interestingnessScore = (actionScore × 0.4) + (emotionScore × 0.3) + (peakMomentScore × 0.3)
```

### Key Code: analyzeTemporalInterestingness

From `src/lib/ai-interestingness.ts`:
```typescript
export async function analyzeTemporalInterestingness(
  videoPath: string,
  durationSec: number,
  opts: {
    windowDuration: number;      // default: 8 seconds
    framesPerWindow: number;     // default: 3 frames
    maxWindows: number;          // default: min(40, ceil(duration/8))
    sport: string;
    eventName: string;
  }
): Promise<{
  windows: Array<{
    windowIndex: number;
    startTime: number;
    endTime: number;
    interestingnessScore: number;
    actionScore: number;
    emotionScore: number;
    peakMomentScore: number;
    description: string;
  }>;
  averageInterestingness: number;
  topWindowIndices: number[];
  totalApiCalls: number;
  failedApiCalls: number;
  modelUsed: string;
}>
```

### Building Segments from Interestingness Windows

After scoring, `buildSegmentsFromWindows()` converts high-interest windows into concrete clip time ranges:

```typescript
export function buildSegmentsFromWindows(
  windows: InterestingnessWindow[],
  opts: { threshold: number; maxSegments: number; mergeGap: number }
): Array<{ startTime: number; endTime: number; avgScore: number }> {
  // Filter windows above threshold
  // Merge adjacent windows if gap < mergeGap seconds
  // Sort by descending avg score, take top maxSegments
}
```

In the SCORE_CLIP handler, these segments become new child CLIP assets:

```typescript
// From score-clip.ts lines 306–332:
const topSegments = buildSegmentsFromWindows(interestingnessResult.windows, {
  threshold: 50, maxSegments: 5, mergeGap: 3,
});

for (const seg of topSegments) {
  await prisma.asset.create({
    data: {
      eventId, type: "CLIP",
      parentAssetId: assetId,        // parent is the scored clip
      immichAssetId,
      startTimeMs: offsetMs + Math.round(seg.startTime * 1000),
      endTimeMs: offsetMs + Math.round(seg.endTime * 1000),
      status: "UPLOADED",
      motionLevel: "HIGH",
      dominantMode: "ACTION",
    },
  });
}
```

### Quote Quality Analysis

Runs a text-only LLM (`llama-3.3-70b` via Venice API) over the transcript to find quotable moments:

```typescript
export async function analyzeQuoteQuality(
  transcript: string,
  speakerSegments: Array<{ speakerLabel: string; start: number; end: number; text: string }>,
  opts: { maxQuotes: number; sport: string; eventName: string }
): Promise<{
  quotes: Array<{
    text: string;
    startTime: number;
    endTime: number;
    speakerLabel: string;
    quoteQualityScore: number;  // 0–100
    reason: string;
  }>;
  averageQuoteQuality: number;
  modelUsed: string;
}>
```

Quote segments are built with padding (`padSeconds: 2`) and stored as child CLIP assets with `dominantMode: "SPEECH"`:

```typescript
// From score-clip.ts lines 335–361:
const quoteSegments = buildSegmentsFromQuotes(quoteQualityResult.quotes, {
  threshold: 60, maxSegments: 4, padSeconds: 2,
});

for (const qs of quoteSegments) {
  await prisma.asset.create({
    data: {
      eventId, type: "CLIP",
      parentAssetId: assetId,
      immichAssetId,
      startTimeMs: offsetMs + Math.round(qs.startTime * 1000),
      endTimeMs: offsetMs + Math.round(qs.endTime * 1000),
      status: "UPLOADED",
      motionLevel: "LOW",
      dominantMode: "SPEECH",
    },
  });
}
```

### Feature Flag

AI interestingness can be disabled entirely via environment variable:
```
AI_INTERESTINGNESS_ENABLED=false
```

And it only runs on clips where it could provide value:
```typescript
const shouldRunInterestingness =
  clipType === ClipType.ACTION || clipType === ClipType.MIXED || clipType === ClipType.MONTAGE;
```

### Graceful Degradation

Both `analyzeTemporalInterestingness` and `analyzeQuoteQuality` are wrapped in try/catch blocks. If either fails, the handler continues without it and records the failure via quality flags:
```typescript
try { interestingnessResult = await analyzeTemporalInterestingness(...); }
catch (err) {
  interestingnessFailed = true;
  log.warn({ err }, "Temporal interestingness analysis failed — continuing without it");
}
```

---

## 7. Clip Type Classification

Clips are classified into four types based on motion and audio scores:

| Clip Type | Condition | Frame Rate | Composition Behavior |
|-----------|-----------|------------|---------------------|
| **ACTION** | motionScore > 60, audioScore < 40 | 3 fps (dense sampling) | Fast cuts, action-focused |
| **SPEECH** | audioScore > 60, motionScore < 40 | 1 fps (sparse sampling) | Score: audio×0.7 + production×0.3 |
| **MIXED** | motionScore > 60 AND audioScore > 40 | 3 fps | Both visual and audio content |
| **MONTAGE** | Neither motion nor audio dominate (default) | 1 fps | General-purpose, flexible |

**Audio Signal Rescue (S1-05):** If `motionScore < 30` but `audioScore > 50` OR `hasCrowdRoar === true`, the clip is upgraded to `MIXED` even if it would otherwise be `MONTAGE`. This prevents low-motion but high-energy audio moments (crowd celebrations, coach speeches) from being discarded.

---

## 8. Dynamic Frame Sampling (S1-04)

Frame extraction rate adjusts dynamically based on clip type to optimize token usage:

```typescript
// From score-clip.ts lines 215–219:
const MAX_FRAMES_PER_CLIP = parseInt(process.env.MAX_FRAMES_PER_CLIP || "120", 10);
const fps = (clipType === ClipType.ACTION || clipType === ClipType.MIXED) ? 3 : 1;
const rawFrameCount = Math.ceil(analysisDuration * fps);
const frameCount = Math.min(rawFrameCount, MAX_FRAMES_PER_CLIP);
const interval = frameCount < rawFrameCount ? analysisDuration / frameCount : 1 / fps;
```

- **ACTION/MIXED clips:** 3 frames per second (dense — captures fast sports action)
- **SPEECH/MONTAGE clips:** 1 frame per second (sparse — less visual change)
- **Hard cap:** `MAX_FRAMES_PER_CLIP` (default 120 frames) prevents runaway token costs for very long clips

### Scene-Cut Aware Keyframe Extraction

Instead of uniform sampling, the extractor first runs ffmpeg scene detection:

```typescript
async function detectSceneChanges(videoPath: string): Promise<number[]> {
  // ffmpeg -i video -vf "select='gt(scene,0.2),showinfo" -an -f null -
  // Returns timestamps where scene change > 0.2 threshold
}
```

Then chooses timestamps based on scene change density:
- **Many scene changes** (2× to maxFrames×2): Pick scene cuts + midpoints
- **Some scene changes** (< 2×): Subsample to maxFrames
- **No scene changes** (continuous video): Uniform interval sampling (fallback)

```typescript
async function extractKeyframes(videoPath, outputDir, maxFrames, interval, duration): Promise<string[]> {
  const sceneChanges = await detectSceneChanges(videoPath);
  let timestamps: number[] = [];
  if (sceneChanges.length >= 2 && sceneChanges.length <= maxFrames * 2) {
    // Scene cuts + midpoints
    for (let i = 0; i < sceneChanges.length; i++) {
      timestamps.push(sceneChanges[i]);
      if (i < sceneChanges.length - 1) {
        timestamps.push((sceneChanges[i] + sceneChanges[i + 1]) / 2);
      }
    }
  } else if (sceneChanges.length > 0) {
    // Subsample
    const step = sceneChanges.length / maxFrames;
    for (let i = 0; i < maxFrames; i++) {
      timestamps.push(sceneChanges[Math.floor(i * step)]);
    }
  } else {
    // Uniform fallback
    for (let i = 0; i < maxFrames; i++) {
      timestamps.push(interval * i + interval / 2);
    }
  }
  // Deduplicate, sort, extract JPEGs via ffmpeg
}
```

---

## 9. Audio Analysis & Crowd Roar Detection

### Motion Score

Uses ffmpeg scene filter at a low threshold (0.05) to count scene-density changes:

```typescript
async function computeMotionScore(videoPath: string): Promise<number> {
  // ffmpeg -i video -vf "select='gt(scene,0.05),showinfo" -an -f null -
  // Count pts_time occurrences → changesPerSecond = count / duration
  // score = min(100, changesPerSecond * 100)
}
```

### Crowd Roar Detection (S1-05)

Uses ffmpeg's `volumedetect` filter to measure audio energy:

```typescript
async function detectCrowdRoar(videoPath: string): Promise<{hasCrowdRoar: boolean; roarScore: number}> {
  // ffmpeg -i video -af "asetnsamples=n=16000,volumedetect" -f null -
  // Parse: mean_volume, max_volume from stderr
  // hasCrowdRoar = meanVol > -15 dB OR maxVol > -3 dB
  // roarScore = min(100, max(0, (meanVol + 40) * 2.5))
}
```

### Transcription

Uses a dual-path approach in `src/lib/transcription.ts`:
1. **Primary:** Venice diarization API — returns word-level timestamps with speaker labels
2. **Fallback:** Local Whisper — returns word-level timestamps without speaker labels
3. **Coach speaker heuristic:** When diarization is unavailable, identifies coach speech by content patterns (phrases like "come on", "let's go", "move", "position", "defense", "attack")

Transcription results are stored as `Asset.transcriptWordsJson` and reused across scoring runs.

---

## 10. Vision Scoring

Frames are sent to the Venice Vision LLM in batches of 6 with a structured prompt:

```
You are a sports media evaluator for Girls In Sports.
Analyze the provided keyframes from a youth sports video clip.
Return ONLY a valid JSON object with:
- momentScore (0-100): faces visible, emotion present, sports action happening,
  story being told, energy level, peak action captured
- productionScore (0-100): camera stability, lighting quality, exposure,
  framing, noise/grain, focus sharpness, color balance
```

Each batch is a separate API call. Failed batches are tracked and reported:

```typescript
export async function analyzeKeyframesWithVision(
  framePaths: string[], sport: string
): Promise<{
  momentScore: number; productionScore: number;
  visionFailedBatches: number; visionUsedFallback: boolean;
}> {
  const batchSize = 6;
  for (let i = 0; i < framePaths.length; i += batchSize) {
    // Read frames as base64, send to Venice API
    // Parse JSON response for momentScore + productionScore
    // On failure: use fallback scores (50/40)
  }
  // Return averages across all batches
}
```

---

## 11. Child Assets & Scene Hierarchy

### Asset Tree Structure

After the full pipeline runs, the asset tree looks like:

```
SOURCE_VIDEO (event upload, 5 min)
├── CLIP #1 (startTimeMs=0, endTimeMs=45000)      ← segment: opening warm-up
│   ├── CLIP #1a (startTimeMs=5000, endTimeMs=13000) ← interestingness window
│   └── CLIP #1b (startTimeMs=28000, endTimeMs=36000) ← quote segment
├── CLIP #2 (startTimeMs=48000, endTimeMs=92000)   ← segment: first play
│   └── CLIP #2a (startTimeMs=10000, endTimeMs=18000) ← interestingness window
├── CLIP #3 (startTimeMs=95000, endTimeMs=145000)  ← segment: goal celebration
├── CLIP #4 (startTimeMs=148000, endTimeMs=210000) ← segment: coach timeout
│   └── CLIP #4a (startTimeMs=5000, endTimeMs=15000)  ← quote segment
└── ...
```

Each CLIP asset can itself have child CLIPs (from interestingness/quote analysis), creating a 2-level or 3-level hierarchy.

### Time Offset Resolution

Child CLIPs store `startTimeMs`/`endTimeMs` relative to their **immediate parent's** time window. When resolving cuts for rendering, `resolve-scene-cut.ts` handles the offset chain:

```typescript
// From src/lib/resolve-scene-cut.ts:
export function resolveSceneCut(params): { downloadImmichId; cutStartMs; cutEndMs } {
  // Real child CLIP (different immich or no parent): cut directly in child's video
  // Legacy virtual scene (same immich + has startTimeMs): translate by child's base offset
  
  const isLegacyVirtual =
    !!asset.parentAssetId && parentAsset &&
    asset.parentAssetId === parentAsset.id &&
    asset.immichAssetId && parentAsset.immichAssetId &&
    asset.immichAssetId === parentAsset.immichAssetId;

  if (isLegacyVirtual) {
    return {
      downloadImmichId: parentAsset.immichAssetId,
      cutStartMs: asset.startTimeMs + scriptStartMs,
      cutEndMs: asset.startTimeMs + scriptEndMs,
    };
  }
  return {
    downloadImmichId: asset.immichAssetId,
    cutStartMs: scriptStartMs,
    cutEndMs: scriptEndMs,
  };
}
```

---

## 12. Render Pipeline: Resolving Scene Cuts for Final Output

When a campaign is rendered, the composer selects clips and assigns start/end times within each clip. The render handlers (`render-proxy.ts` and `render-final.ts`) use `resolve-scene-cut.ts` to translate these script-relative times into absolute cuts in the source video.

### Render Flow

```
RENDER_PROXY / RENDER_FINAL
├── 1. Load campaign + campaign clips + assets
├── 2. For each campaign clip:
│     ├── resolveSceneCut(asset, parentAsset, scriptStartMs, scriptEndMs)
│     │     → Returns: { downloadImmichId, cutStartMs, cutEndMs }
│     ├── Download source video from Immich (deduplicated by immichId)
│     ├── Apply beat-sync adjustment (if music + beat timestamps available)
│     │     → src/lib/beat-sync-service.ts
│     ├── Cut segment: ffmpeg -ss -to -i source -c copy segment_{n}.mp4
│     └── Generate text overlay if narrative label present
├── 3. Concatenate all segments
│     → ffmpeg -f concat -i filelist.txt -c copy (or re-encode if scaling)
├── 4. Scale to target resolution
│     → PROXY: 720×1280, CRF 28, veryfast preset, DRAFT watermark
│     → FINAL: 1080×1920, CRF 18, GIS branding overlay
├── 5. Mix with music (if available)
│     → ffmpeg loudnorm normalization
│     → Mix at configurable volume level
├── 6. Upload result to Immich
├── 7. Create output Asset (type=PROXY or FINAL)
└── 8. Update campaign status
```

### Beat-Sync Adjustments

When music with BPM/beat data is available, the `beat-sync-service.ts` (`src/lib/beat-sync-service.ts`) analyzes the audio track using a Python `librosa` script and returns beat timestamps. The render handler optionally adjusts scene cut timestamps to align with the nearest beat, creating a rhythmically-synced edit:

```
Python script: scripts/analyze_beats.py
Input: audio/video file path
Output: { bpm: number, beatTimestamps: number[], confidence: number }
```

The beat sync is applied during the cut resolution step in both `render-proxy.ts` and `render-final.ts`.

---

## 13. Job Orchestration & State Machine

### Job Types & Concurrency

Defined in `src/lib/queues.ts`:

| Job Type | Concurrency | Limiter | Timeout |
|----------|-------------|---------|---------|
| INGEST_CLIP | 3 | — | 10 min |
| SCORE_CLIP | 4 | — | 5 min |
| DIRECT_SCRIPT | 1 | 10/min | 5 min |
| RENDER_PROXY | 2 | — | 15 min |
| RENDER_FINAL | 1 | — | 30 min |
| GENERATE_MUSIC | 2 | — | 10 min |

### Job Lifecycle

```
QUEUED → RUNNING → DONE
           ↓
         (error, attempts < maxAttempts)
           ↓
        RETRYING (exponential backoff: 2^attempt sec, max 60s)
           ↓
        QUEUED → RUNNING → DONE
           ↓
         (error, attempts >= maxAttempts)
           ↓
         FAILED
```

### Stale Job Recovery

The worker runs a periodic reclaim check (every 5 minutes) that:
1. Finds `RUNNING` jobs with `startedAt` older than 30 minutes
2. Resets them to `QUEUED` with incremented attempts
3. Re-enqueues them into BullMQ (with race guard to prevent double-processing)
4. Also re-enqueues orphaned `QUEUED` jobs (created > 30 min ago, never picked up)

```typescript
// From job-worker.ts lines 48–120:
async function reclaimStaleJobs() {
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
  
  // Reclaim stale RUNNING jobs
  UPDATE jobs SET status='QUEUED', startedAt=NULL, attempts=LEAST(attempts+1, maxAttempts)
  WHERE status='RUNNING' AND (startedAt IS NULL OR startedAt < staleThreshold)
  
  // Re-enqueue orphaned QUEUED jobs
  SELECT id, type, payload FROM jobs
  WHERE status='QUEUED' AND createdAt < staleThreshold AND attempts < maxAttempts
}
```

### Sibling Completion & Rollup

When scoring child CLIPs of a source video, the system tracks completion:

```typescript
// From score-clip.ts lines 512–522:
if (asset.parentAssetId) {
  const siblings = await prisma.asset.count({
    where: { parentAssetId: asset.parentAssetId, status: { not: AssetStatus.SCORED } },
  });
  if (siblings === 0) {
    // All children scored — mark parent as SCORED
    await prisma.asset.update({
      where: { id: asset.parentAssetId },
      data: { status: AssetStatus.SCORED },
    });
  }
}
```

For push notifications, `markDone()` in `job-worker.ts` checks if all sibling `SCORE_CLIP` jobs for a parent ingest are complete before sending the "Footage Ready" push.

### Circuit Breaker

`src/lib/cost-estimator.ts` implements a per-event circuit breaker:
- In-memory counter tracks consecutive failures per event
- Three consecutive failures → 10-minute pause on all jobs for that event
- All handlers (`INGEST_CLIP`, `SCORE_CLIP`, `DIRECT_SCRIPT`) gate on `isEventCircuitPaused(eventId)` before proceeding

---

## 14. End-to-End Data Flow Diagram

```
USER UPLOADS VIDEO
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  API ROUTE: POST /api/events/[id]/upload                             │
│  • Creates Asset(type=SOURCE_VIDEO, status=UPLOADED)                 │
│  • Enqueues INGEST_CLIP job                                          │
│  • Returns 202 Accepted                                              │
└──────────────────────────────────────────────────────────────────────┘
       │ (async)
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  INGEST_CLIP JOB                                                     │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ 1. Download from Immich                                     │     │
│  │ 2. ffprobe metadata                                         │     │
│  │ 3. Circuit breaker + budget check                           │     │
│  │ 4. STT transcription (Venice diarization → Whisper fallback) │     │
│  │ 5. Store transcriptWordsJson on Asset                       │     │
│  │ 6. segmentVideo(): multi-pass scene detection                │     │
│  │    ├── ffmpeg scene-filter motion scoring                    │     │
│  │    ├── Boundary detection (motion tier changes)              │     │
│  │    ├── I-frame snapping                                      │     │
│  │    ├── Speech refinement (transcript boundaries)             │     │
│  │    └── Merge short clips                                     │     │
│  │ 7. Create child Asset(type=CLIP) per segment                 │     │
│  │ 8. Enqueue SCORE_CLIP per child (with parentJobId)           │     │
│  └────────────────────────────────────────────────────────────┘     │
│  Status → INGESTING (source) / UPLOADED (children)                  │
└──────────────────────────────────────────────────────────────────────┘
       │ (N parallel jobs, one per child clip)
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SCORE_CLIP JOB (per child CLIP)                                     │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ 1. Download clip / cut window from parent                    │     │
│  │ 2. Circuit breaker + budget check                            │     │
│  │ 3. STT (reuse or run fresh)                                  │     │
│  │ 4. computeAudioScore() → keywords, speaker-aware, density    │     │
│  │ 5. computeMotionScore() → ffmpeg scene density               │     │
│  │ 6. detectCrowdRoar() → ffmpeg volumedetect                   │     │
│  │ 7. assignClipType() → ACTION/SPEECH/MIXED/MONTAGE            │     │
│  │ 8. Dynamic frame sampling (3fps ACTION, 1fps SPEECH)         │     │
│  │ 9. extractKeyframes() → scene-cut aware JPEGs                │     │
│  │ 10. analyzeKeyframesWithVision() → Venice Vision LLM         │     │
│  │ 11. analyzeTemporalInterestingness() → AI window scoring     │     │
│  │ 12. analyzeQuoteQuality() → AI quote analysis                │     │
│  │ 13. Create child CLIPs from interestingness/quotes           │     │
│  │ 14. computeTieredScore() → composite score                   │     │
│  │ 15. Upsert ClipScore record                                  │     │
│  │ 16. Write Immich tags + AssetTag records                     │     │
│  │ 17. Auto-thumbnail (if best in event)                        │     │
│  │ 18. Sibling completion check → parent SCORED                 │     │
│  └────────────────────────────────────────────────────────────┘     │
│  Status → SCORED                                                    │
└──────────────────────────────────────────────────────────────────────┘
       │ (all children scored)
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  EVENT STATUS: All clips scored → Push: "Footage Ready"              │
│  User reviews in /events/[id]/curate                                │
│  Selects clips → Creates Campaign → Enqueues DIRECT_SCRIPT           │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DIRECT_SCRIPT → GENERATE_MUSIC + RENDER_PROXY (parallel)            │
│       │                                                              │
│       └──→ RENDER_FINAL (sequential)                                 │
│            • resolveSceneCut() per selected clip                     │
│            • Beat-sync alignment                                     │
│            • ffmpeg segment assembly                                 │
│            • Scale + branding overlay                                │
│            • Music mix (loudnorm)                                    │
│            • Upload to Immich                                        │
│            • Campaign status → DONE                                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 15. Referenced Files

### Core Scene Detection & Segmentation
| File | Role |
|------|------|
| `src/lib/video-segmentation.ts` | Core segmentation algorithm: motion scoring, boundary detection, I-frame snapping, speech refinement, clip merging |
| `src/lib/scene-detection-service.ts` | Service layer: wraps `segmentVideo()`, manages Immich downloads, child asset creation, job enqueueing |
| `src/lib/handlers/ingest-clip.ts` | INGEST_CLIP job handler: orchestrates download → transcription → segmentation → enqueue scoring |

### Scoring & Analysis
| File | Role |
|------|------|
| `src/lib/handlers/score-clip.ts` | SCORE_CLIP job handler: audio/motion/vision scoring, AI interestingness, clip type assignment, ClipScore upsert |
| `src/lib/ai-interestingness.ts` | AI temporal window scoring + quote quality analysis + segment building utilities |
| `src/lib/transcription.ts` | Dual-path STT: Venice diarization (primary) + Whisper (fallback), word-level timestamps |
| `src/lib/tier-formulas.ts` | Quality-tiered score formulas: AMATEUR/INTERMEDIATE/PROFESSIONAL weights |
| `src/lib/cost-estimator.ts` | Budget enforcement, circuit breaker, per-job cost estimation |

### Infrastructure & Orchestration
| File | Role |
|------|------|
| `src/lib/job-worker.ts` | BullMQ worker setup, job lifecycle management, stale job reclamation, health server, push notifications |
| `src/lib/queues.ts` | Queue definitions, concurrency settings, rate limiters |
| `src/scripts/worker.ts` | Worker process entry point: registers handlers, starts BullMQ workers + health server |
| `src/lib/ffmpeg-utils.ts` | Memory-safe ffmpeg/ffprobe spawn wrappers (`spawnLimitedFfmpeg`, `spawnLimitedFfprobe`) |

### Render Pipeline
| File | Role |
|------|------|
| `src/lib/resolve-scene-cut.ts` | Resolves script-relative cut times to absolute offsets in source video, handling parent/child asset chains |
| `src/lib/handlers/render-proxy.ts` | Proxy render: low-res draft with watermark, CRF 28, 720×1280 |
| `src/lib/handlers/render-final.ts` | Final render: high-res output, CRF 18, branding overlay, 1080×1920 |
| `src/lib/beat-sync-service.ts` | Beat detection wrapper: calls Python `librosa` script for BPM/beat timestamps, enables rhythm-synced edits |

### Data Model
| File | Role |
|------|------|
| `prisma/schema.prisma` | Full database schema: Asset, ClipScore, Campaign, CampaignClip, Job, SceneSegment (deprecated), all enums |

### Quality & Monitoring
| File | Role |
|------|------|
| `src/lib/handlers/quality-tracking.ts` | Centralized quality flag recording + partial success marking for US-014 |
| `src/lib/logger.ts` | Structured logging utility |

### API Routes
| File | Role |
|------|------|
| `src/app/api/events/[id]/clips/route.ts` | API endpoint for retrieving event clips and their scores |
| `src/app/events/[id]/page.tsx` | Frontend event detail page with clip browsing UI |

### Tests
| File | Covers |
|------|--------|
| `__tests__/score-clip-scenes.test.ts` | Scene detection + clip scoring integration tests |
| `__tests__/ai-interestingness.test.ts` | AI temporal interestingness + quote quality unit tests |
| `__tests__/render-scene-cut.test.ts` | Scene cut resolution logic tests |
| `__tests__/render-beat-sync.test.ts` | Beat-sync adjustment tests |
| `__tests__/render-low-res-decision.test.ts` | Proxy render decision logic tests |
| `__tests__/score-clip-quality.test.ts` | Clip quality scoring tests |
| `__tests__/bullmq-integration.test.ts` | Job queue integration tests |
| `__tests__/clips-child-assets.test.ts` | Child asset creation and hierarchy tests |
| `__tests__/us014-quality-tracking.test.ts` | Quality tracking + error recording tests |

### Documentation
| File | Role |
|------|------|
| `docs/SEGMENTATION_TECHNICAL_DOCUMENTATION.md` | Prior pipeline documentation (v1.0, 2026-05-24) — covers end-to-end architecture, AI usage, quality control |
| `docs/scene_and_clips.md` | **This document** — deep dive into scene detection and clip creation |

---

## Appendix: Key Design Decisions

1. **Why child Assets instead of a separate `SceneSegment` table?**  
   The deprecated `SceneSegment` model stored scenes separately from Assets, creating duplication and synchronization problems. Child CLIP Assets unify the data model — clips are Assets, scenes are Assets, final renders are Assets. This means scoring, tagging, and curation all operate on the same entity type. The migration script at `scripts/migrate-legacy-scenes-to-child-assets.ts` handles the transition.

2. **Why multiple scoring signals instead of just AI?**  
   Venice Vision LLM calls are expensive (~$0.015 per frame) and slow. The non-AI signals (motion density, keyword matching, crowd roar detection, clip type classification) provide immediate, zero-cost scoring that:
   - Filters out clips before expensive Vision API calls
   - Determines frame sampling rate (saving tokens on static clips)
   - Provides fallback when Vision API is unavailable
   - Enables "audio signal rescue" for moments where AI vision alone would miss the excitement

3. **Why the 8-second window for temporal interestingness?**  
   Youth sports plays typically last 3–15 seconds. An 8-second window with 3 frames provides enough temporal context for the Vision LLM to evaluate the action without being so wide that multiple distinct plays get averaged together. The window count is capped at 40 to prevent runaway API costs on very long videos.

4. **Memory safety with ffmpeg.**  
   All ffmpeg/ffprobe spawns use `spawnLimitedFfmpeg()` / `spawnLimitedFfprobe()` from `src/lib/ffmpeg-utils.ts`. These set `nice: 15` and `-threads 2` to limit CPU/memory impact. The worker node heap is capped at 512 MB. Files are never read synchronously with `readFileSync()` beyond small metadata. Large video downloads use `createReadStream()` with `highWaterMark: 64 * 1024`.