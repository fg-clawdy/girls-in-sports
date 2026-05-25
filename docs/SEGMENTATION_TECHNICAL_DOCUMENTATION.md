# GIS Pipeline: End-to-End Technical Architecture

**Version:** 1.0  
**Date:** 2026-05-24  
**Project:** Girls In Sports — AI Highlight Engine  
**Scope:** Complete pipeline from media upload through campaign-ready state, including quality control and post-processing verification.

---

## Executive Summary

The Girls In Sports pipeline ingests raw sports media uploaded by users, decomposes it into discrete highlight clips using motion analysis and speech-to-text transcription, scores each clip independently via vision and audio AI, and ultimately assembles a production script for a polished highlight reel — all driven by an asynchronous job queue with built-in cost controls, circuit breakers, and quality tracking.

**Key architectural principle:** The pipeline is an event-driven, async job processor. User-facing API routes (Next.js) accept uploads and enqueue jobs. A separate Node.js worker process (`src/scripts/worker.ts`) polls the `Job` table, claims jobs atomically, and dispatches them to type-specific handlers. No long-running AI calls block HTTP requests — the user sees progress updates via job status polling and push notifications.

**AI usage breakdown:**
- **Vision LLM (Venice API):** Used in `SCORE_CLIP` handler to analyze extracted video frames and produce `momentScore` (0–100) and `productionScore` (0–100). Also used in `INGEST_CLIP` for initial frame-level content tagging. Model: configurable via `VENICE_MODEL` env var. Each call processes up to 24 frames.
- **Audio/STT (Speech-to-Text):** Used in `INGEST_CLIP` to produce word-level timestamps and full-text transcripts. These drive speech-mode segmentation in the upcoming Sprint 1.
- **Text LLM (Venice API):** Used in `DIRECT_SCRIPT` handler to generate structured `ProductionScript` JSON from scored clips. Model: `deepseek-v4-pro` (configurable). Temperature 0.4 for deterministic output with `response_format: json_schema`.
- **Music Generation (Venice API):** Used in `GENERATE_MUSIC` handler to produce background tracks for highlight reels.
- **ffmpeg/ffprobe (local processing):** All video metadata extraction, frame sampling, audio RMS analysis, and eventual rendering use ffmpeg. No AI involved — these are deterministic local operations.
- **Scene cut detection (local processing):** `resolve-scene-cut.ts` uses ffmpeg scene detection filters (non-AI) to find optimal cut points at I-frame boundaries.

**Quality control:**
- **Budget enforcement:** Every job type checks against a per-event cost budget (`cost-estimator.ts`). `checkAndReserveBudget()` atomically increments `currentEstimatedCost` before any AI call. Budget exceeded = job refused.
- **Circuit breaker:** Three consecutive failures on an event pause all subsequent jobs for 10 minutes (`isEventCircuitPaused()`). The `DIRECT_SCRIPT`, `SCORE_CLIP`, and `INGEST_CLIP` handlers all gate on this.
- **Quality flags:** Every handler calls `recordQualityFlags()` on per-stage success/failure. These are stored in `Job.qualityFlags` JSONB for post-mortem analysis. The `/api/events/[id]/quality-flags` endpoint exposes them for user-facing dashboards.
- **Retry with exponential backoff:** Jobs are retried up to `maxAttempts` (default 3) with delays of 2^attempt seconds. `DIRECT_SCRIPT` has its own 3-attempt retry loop with error feedback to the LLM.
- **Fallback scripts:** `composer.ts` `generateCompositionScript()` falls back to a deterministic grid/cut layout if the Venice API is unavailable — graceful degradation rather than failure.

**Clip completeness verification (current state):** In the current codebase, there is **no automated post-creation verification** that clips are "complete and satisfactory." After `SCORE_CLIP` completes, the result is written to `ClipScore` and the parent job is marked `DONE`. The only validation is:
1. `DIRECT_SCRIPT` validates that must-include clips appear in the LLM output and that timestamps fall within clip duration bounds (lines 118–143).
2. `markDone()` in `job-worker.ts` triggers push notifications only when ALL sibling SCORE_CLIP jobs for a parent ingest are finished (counts pending sibling jobs, lines 136–145).
3. The quality flag system records per-stage success/failure but does not evaluate clip "quality" — it only records whether the job threw an error.

**Sprint 1 introduces:** No new post-creation verification step. The focus is on making clips *exist* and be *scored correctly*. Quality verification of clip output is deferred to Sprint 2+.

---

## Pipeline Stages — Detailed Walkthrough

### Stage 0: Event Creation

**Actor:** User (via UI)  
**Route:** `POST /api/events`  
**Handler:** `src/app/api/events/route.ts`  
**AI Used:** None  

Creates an `Event` record with metadata (name, sport, city, date, etc.). Assigns a cost budget and initializes `currentEstimatedCost = 0`.

**Output:** Event with `id`, status `CREATED`.

---

### Stage 1: Media Upload

**Actor:** User (via UI)  
**Route:** `POST /api/events/[id]/upload`  
**Handler:** `src/app/api/events/[id]/upload/`  
**AI Used:** None  

User uploads video/image files. Files are stored and an `Asset` record is created with:
- `type = SOURCE_VIDEO` or `IMAGE`
- `status = UPLOADED`
- `filePath` pointing to stored file
- `parentAssetId = null` (no parent — this is a source)

**Quality checkpoint:** File size/type validation at the API layer. No AI validation at this stage.

---

### Stage 2: INGEST_CLIP Job (Analysis & Cataloging)

**Trigger:** Enqueued automatically after upload succeeds.  
**Handler:** `src/lib/handlers/ingest-clip.ts`  
**Worker:** `src/scripts/worker.ts` picks up `JobType.INGEST_CLIP` jobs from the queue.

#### Current Implementation (Pre-Sprint 1)

```
INGEST_CLIP Job
├── [1] Extract metadata via ffprobe (duration, codec, resolution, fps)
│       → FFprobe parse, no AI
├── [2] Check circuit breaker: isEventCircuitPaused(eventId)
│       → In-memory map in cost-estimator.ts
├── [3] Check budget: checkAndReserveBudget(eventId, projectedCost)
│       → Atomic increment on Event.currentEstimatedCost
├── [4] Run STT transcription (Venice API or local whisper)
│       → Returns full transcript with word-level timestamps
│       → AI: Speech-to-Text (model determined by Venice API)
├── [5] Call scene detection service (scene-detection-service.ts)
│       → CURRENTLY STUBBED — does NOT produce child Asset records
│       → This is the gap Sprint 1 fills
├── [6] Save metadata to Asset record
│       → Updates durationSeconds, fileMetadata JSONB
├── [7] Record quality flags (success/failure)
│       → quality-tracking.ts records to Job.qualityFlags
└── [8] Enqueue SCORE_CLIP job for this asset
        → job-worker.ts enqueueJob(SCORE_CLIP, { assetId, eventId, ... })
```

**AI Used:** Stage [4] uses STT (Speech-to-Text) — an AI/ML service for transcription.

**What's missing (Sprint 1 fix):** Stage [5] currently returns segment data but does NOT write child `Asset` records. `SCORE_CLIP` therefore scores the entire source video as one unit, producing the "scoring collapse" problem.

**Post-Sprint 1, Stage [5] becomes:**

```
[5] Call segmentVideo(filePath, transcriptWords) → segments[]
    ├── ffmpeg scene-filter: motion scoring pass (local, no AI)
    ├── Boundary detection: motion tier change + silence gaps
    ├── I-frame snapping
    ├── Speech refinement: transcript-driven sentence boundaries
    ├── Merge short clips (<4s)
    └── For each segment:
          ├── Create child Asset (type=CLIP, parentAssetId=source.id)
          └── Enqueue SCORE_CLIP job for child Asset
```

---

### Stage 3: SCORE_CLIP Job (Per-Clip Analysis)

**Trigger:** Enqueued at end of `INGEST_CLIP` (one job per clip).  
**Handler:** `src/lib/handlers/score-clip.ts`  
**Worker:** Picks up `JobType.SCORE_CLIP` jobs.

#### Current Implementation (Pre-Sprint 1)

```
SCORE_CLIP Job (scores the FULL source video — not individual clips)
├── [1] Load Asset + event
├── [2] Check circuit breaker
├── [3] Vision Analysis (vision.ts)
│       ├── Extract frames at fixed intervals using ffmpeg
│       │     → Local ffmpeg, no AI
│       ├── Send frames to Venice Vision LLM
│       │     → AI: Vision LLM call
│       ├── Returns: momentScore (0–100), productionScore (0–100),
│       │          clipType (ACTION/SPEECH/MONTAGE/SLOW_MO),
│       │          reasons array, tags
│       └── Frame count: FIXED (not dynamic — Sprint 1 fixes this)
├── [4] Audio Analysis (audio-analysis.ts)
│       ├── Extract audio track via ffmpeg
│       ├── Compute RMS, peak, spectral centroid
│       │     → Local ffmpeg/audio processing, no AI
│       ├── Match transcript keywords to keyword lists
│       │     → Local text matching
│       └── Returns: audioScore (0–100), hasCoachSpeech flag
├── [5] Compute composite score (tier-formulas.ts)
│       ├── Standard: momentScore * 0.5 + productionScore * 0.3 + audioScore * 0.2
│       └── Tier multipliers applied (HIGH/MEDIUM/LOW quality tiers)
├── [6] Upsert ClipScore record
│       → Database write
├── [7] Tag Asset (hasCoachSpeech, hasActionKeyword, etc.)
│       → Database write to AssetTag
├── [8] Record quality flags
└── [9] Check if all sibling clips done → send push notification
```

**AI Used:** Stage [3] uses Vision LLM (Venice API) — the most expensive AI call in the pipeline. Each call sends 3–15 frames (currently fixed).

**What's missing (Sprint 1 fix):**
- Scores the full source video instead of individual clips → **scoring collapse**
- Fixed frame count regardless of content → wastes tokens on static scenes, under-samples action
- No SPEECH-specific scoring formula → speech clips disadvantaged
- No audio rescue for low-motion high-audio clips

**Post-Sprint 1 additions:**
- Only scores child `CLIP` Assets (skips `SOURCE_VIDEO` with children)
- Dynamic frame sampling: 1 frame/3s for LOW, 2/s for MEDIUM, 4/s for HIGH, capped at 24
- Speech formula: 30% visual / 70% audio for `dominantMode=SPEECH`
- Audio rescue: LOW motion + audioScore ≥ 60 → lift momentScore floor to 40
- Sibling rollup: After all children scored, parent gets `compositeScore = max(children)`
- `speechIntensityScore` stored on ClipScore for speech clips

---

### Stage 4: Event Status: "Scored" (Ready for Curation)

After ALL `SCORE_CLIP` jobs for an event complete:
- `markDone()` in `job-worker.ts` detects that the last sibling job finished (counts pending sibling jobs = 0)
- Push notification sent: "Footage Ready — clips scored and tagged"
- User navigates to `/events/[id]/curate` to review scored clips

**No automated quality verification** runs at this stage. Clips are presented to the user as-is. The user can:
- View clip scores (momentScore, productionScore, compositeScore)
- View clip tags (hasCoachSpeech, clipType, etc.)
- Manually review and reject clips

---

### Stage 5: Campaign Creation & Curation

**Actor:** User (via UI)  
**Route:** `POST /api/events/[id]/campaigns`  
**Handler:** `src/app/api/events/[id]/campaigns/route.ts`  

User selects clips, sets creative parameters (target format: REEL_15, REEL_30, REEL_60, etc.), brief, energy preset, must-include clips.

Creates `Campaign` record with associated `CampaignClip` junction records.

**Enqueues:** `DIRECT_SCRIPT` job.

---

### Stage 6: DIRECT_SCRIPT Job (Production Script Generation)

**Handler:** `src/lib/handlers/direct-script.ts`  
**AI Used:** Text LLM (Venice API, model: `deepseek-v4-pro`)

```
DIRECT_SCRIPT Job
├── [1] Load campaign + event + accepted clips with scores/tags
├── [2] Check circuit breaker
├── [3] Build LLM prompt:
│       ├── System: Agentic Video Director persona
│       ├── Rules: clip validity, must-includes, duration bounds, pacing
│       ├── Brand: GIS colors, empowering tone
│       └── User: event metadata, target format, clip manifest with scores
├── [4] LLM Call (up to 3 retries with error feedback)
│       ├── response_format: json_schema (strict)
│       ├── reasoning_effort: high
│       └── Returns: ProductionScript JSON
├── [5] Validation (post-LLM, local):
│       ├── All must-include clips present
│       ├── All timestamps within source clip bounds
│       ├── Total duration within ±10% of target
│       └── If invalid → retry with correction hint to LLM
├── [6] Persist scriptJson to Campaign
├── [7] Enqueue parallel jobs: GENERATE_MUSIC + RENDER_PROXY
└── [8] Record quality flags
```

**Verification/QC at this stage:**
- ✅ Must-include clip presence check (hard check, throws error if missing)
- ✅ Timestamp bounds validation (hard check)
- ✅ Duration tolerance check (hard check, ±10%)
- ✅ Retry loop with error feedback to LLM (up to 3 attempts)

---

### Stage 7: GENERATE_MUSIC + RENDER_PROXY (Parallel)

**Handlers:**
- `src/lib/handlers/generate-music.ts` — generates background music track
- `src/lib/handlers/render-proxy.ts` — produces low-resolution rough draft

**AI Used:**
- Music generation: Venice API `music/generate` endpoint — AI generated music
- Render proxy: ffmpeg concatenation + scaling — no AI

---

### Stage 8: RENDER_FINAL Job

**Handler:** `src/lib/handlers/render-final.ts`

Produces final high-resolution video using ffmpeg assembly:
- Scene cuts resolved via `resolve-scene-cut.ts` (snap to I-frames)
- Beat-sync editing via `beat-sync-service.ts` (aligns cuts to music BPM)
- Branding overlay (GIS logo, colors)
- Output: MP4 at target resolution

**AI Used:** None (deterministic ffmpeg processing)

**Push notification:** "Final Render Ready — your campaign video is ready to download."

---

## AI Usage Summary Table

| Stage | AI Service | Model | Input | Output | Cost Category |
|-------|-----------|-------|-------|--------|---------------|
| INGEST_CLIP | STT (Venice) | Venice STT | Audio track | Word-level transcript | `sttPerMinute: $0.005/min` |
| SCORE_CLIP | Vision LLM (Venice) | Venice vision model | Extracted frames | momentScore, productionScore, clipType, tags | `visionPerImage: $0.015/frame` |
| DIRECT_SCRIPT | Text LLM (Venice) | `deepseek-v4-pro` | Clip manifest + event metadata | ProductionScript JSON | `textInput: $0.0001/1K tokens` |
| GENERATE_MUSIC | Music Gen (Venice) | Venice music model | Style/BPM prompt | Audio file | `musicGen: $0.10/request` |
| COMPOSITION (legacy) | Text LLM (Venice) | Configurable | Assets + event | CompositionScript JSON | `textInput/Output` |

---

## Processing Location Summary

| Process | Where | AI/Server |
|---------|-------|-----------|
| Upload handling | Next.js API route | Server (no AI) |
| ffprobe metadata extraction | Worker process | Server (local) |
| ffmpeg frame extraction | Worker process | Server (local) |
| ffmpeg motion analysis | Worker process | Server (local) |
| ffmpeg audio RMS analysis | Worker process | Server (local) |
| ffmpeg rendering | Worker process | Server (local) |
| STT transcription | Worker → Venice API | AI (remote) |
| Vision LLM scoring | Worker → Venice API | AI (remote) |
| Text LLM script generation | Worker → Venice API | AI (remote) |
| Music generation | Worker → Venice API | AI (remote) |
| Scene cut resolution | Worker process | Server (local) |
| Beat-sync editing | Worker process | Server (local) |
| Cost budget enforcement | Worker process | Server (local) |
| Quality flag recording | Worker process | Server (local) |
| Circuit breaker | Worker process (in-memory) | Server (local) |
| Push notifications | Worker process | Server (local) |

---

## Quality Control & Post-Processing Verification

### What Exists Today

1. **Budget enforcement** (`cost-estimator.ts`): Every AI-calling handler must reserve budget via `checkAndReserveBudget()` before making the call. The budget check is atomic (prisma increment). Budget exceeded = job fails before spending money.

2. **Circuit breaker** (`cost-estimator.ts`): In-memory per-event failure counter. Three consecutive failures → 10-minute pause on all jobs for that event. Protects against runaway failures burning budget.

3. **Quality flags** (`quality-tracking.ts`): Every handler records per-stage success/failure flags in `Job.qualityFlags` JSONB. This includes: `failed`, `error`, `fallbackUsed`, `visionFailedBatches`, `visionUsedFallback`, and a human-readable `message`. User can view via `/api/events/[id]/quality-flags`.

4. **DIRECT_SCRIPT validation** (`direct-script.ts` lines 117–143): Post-LLM validation:
   - Must-include clip presence (throws error if missing)
   - Timestamp bounds check (throws error if out of range)
   - Duration tolerance ±10% (throws error if off)
   - Auto-correction of minor duration mismatches (rounding tolerance)

5. **Retry with backoff** (`job-worker.ts` lines 174–197): Jobs automatically retry up to 3 times with exponential delay (2^attempt seconds). `DIRECT_SCRIPT` has its own 3-attempt retry with error feedback to the LLM.

6. **Fallback composition scripts** (`composer.ts` lines 275–369): When Venice API is unavailable, `generateCompositionScript()` generates a deterministic fallback script. Graceful degradation.

7. **Atomic job claiming** (`job-worker.ts` lines 53–77): `FOR UPDATE SKIP LOCKED` on the jobs table prevents duplicate processing.

### What Does NOT Exist (Gaps)

1. **No clip completeness verification:** After `SCORE_CLIP` writes a `ClipScore`, there is no check that the clip is "complete" (has valid start/end times, non-empty transcript window, sufficient frame coverage). The score is accepted at face value.

2. **No score anomaly detection:** If a clip scores 100/100 or 0/100 on all dimensions, no alert is raised. Extreme uniform scores could indicate a hallucination — no detection.

3. **No clip coverage verification:** No check that all child clips collectively span the full source duration. A gap in coverage would not be detected.

4. **No post-render quality check:** After `RENDER_FINAL` completes, there is no automated check for output file size, duration, or codec validity. The file is presumed valid if ffmpeg exits 0.

5. **No A/B scoring comparison:** If the same clip is scored twice (e.g., after a re-run), scores are not compared. The new score overwrites the old via `upsert`.

6. **No human-in-the-loop verification:** Curation is manual — the user must review clips and accept/reject them. The system does not flag clips that "look wrong."

### Sprint 1 Quality Additions

The Sprint 1 PRD does not add new post-processing verification steps. It focuses on:

- Making segmentation produce real clips (fixing the "no clips" gap)
- Making scoring operate per-clip (fixing the "scoring collapse")
- Making frame sampling content-aware (fixing the "wasted tokens / under-sampled peaks")

Quality verification improvements (anomaly detection, coverage checks, render validation) are deferred to a future sprint focused on pipeline reliability.

---

## End-to-End Flow Diagram

```
USER UPLOADS MEDIA
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  NEXT.JS API ROUTE: /api/events/[id]/upload                      │
│  • Saves file                                                    │
│  • Creates Asset(type=SOURCE_VIDEO, status=UPLOADED)             │
│  • Enqueues INGEST_CLIP job                                      │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼ (async — user gets 202 response immediately)
┌──────────────────────────────────────────────────────────────────┐
│  WORKER: picks up INGEST_CLIP job                                │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ [LOCAL] ffprobe: duration, codec, fps, resolution        │    │
│  │ [AI-STT] Speech-to-Text: word-level transcript           │    │
│  │ [LOCAL] ffmpeg scene-filter: motion analysis             │    │
│  │ [LOCAL] segmentVideo(): split into clips                 │    │
│  │ [LOCAL] Create child Asset(type=CLIP) per segment        │    │
│  │ [LOCAL] Enqueue SCORE_CLIP job per child clip             │    │
│  └──────────────────────────────────────────────────────────┘    │
│  Status → INGESTING                                              │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼ (one SCORE_CLIP job per child clip, parallel)
┌──────────────────────────────────────────────────────────────────┐
│  WORKER: picks up SCORE_CLIP job (child CLIP Asset)              │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ [LOCAL] sampleFramesDynamic(): pick frame timestamps     │    │
│  │ [LOCAL] ffmpeg -ss -t: extract windowed frames           │    │
│  │ [AI-VISION] Venice Vision LLM: momentScore, prodScore   │    │
│  │ [LOCAL] ffmpeg audio RMS: windowed audio analysis        │    │
│  │ [LOCAL] tier-formulas.ts: composite score                │    │
│  │ [LOCAL] Upsert ClipScore                                 │    │
│  │ [LOCAL] Tag Asset                                        │    │
│  └──────────────────────────────────────────────────────────┘    │
│  If last sibling → roll up max composite to parent               │
│  Status → SCORED (parent and child)                             │
│  Push: "Footage Ready"                                          │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  USER: Reviews clips in /events/[id]/curate                      │
│  • Views scores, tags, transcript excerpts                       │
│  • Selects clips for campaign                                    │
│  • Sets target format, brief, must-includes                      │
│  • Creates Campaign → enqueues DIRECT_SCRIPT                     │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  WORKER: picks up DIRECT_SCRIPT job                              │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ [AI-TEXT] Venice LLM (deepseek-v4-pro): ProductionScript │    │
│  │ [LOCAL] Validate: must-includes, timestamps, duration    │    │
│  │ [LOCAL] Retry up to 3x with correction hints             │    │
│  │ [LOCAL] Persist scriptJson to Campaign                    │    │
│  │ [LOCAL] Enqueue GENERATE_MUSIC + RENDER_PROXY (parallel) │    │
│  └──────────────────────────────────────────────────────────┘    │
│  Push: "Script Ready" (if last sibling SCORE_CLIP already done) │
└──────────────────────────────────────────────────────────────────┘
       │
       ├──────────────────────┐
       ▼                      ▼
┌──────────────┐    ┌──────────────────┐
│ GENERATE_    │    │ RENDER_PROXY     │
│ MUSIC        │    │ • ffmpeg assembly│
│ • Venice API │    │ • Low-res proxy  │
│ • AI-MUSIC   │    │ • I-frame snaps  │
│              │    │ • Beat-sync      │
└──────────────┘    └──────────────────┘
       │                      │
       └──────────┬───────────┘
                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  WORKER: picks up RENDER_FINAL job                               │
│  • ffmpeg assembly with music, overlays, branding                │
│  • High-resolution output                                        │
│  Push: "Final Render Ready"                                     │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  USER: Downloads final video from /campaigns/[id]/download       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Cost Estimate per Event (Typical)

*Based on `cost-estimator.ts` pricing constants:*

| Step | Unit Cost | Units per Event | Subtotal |
|------|----------|----------------|----------|
| STT transcription | $0.005/min | ~3 min (avg) | $0.015 |
| Vision LLM (per frame) | $0.015/frame | ~10 clips × 12 frames = 120 | $1.80 |
| Direct script | $0.0001/1K tokens in | ~5K tokens | $0.001 |
| Music generation | $0.10/request | 1 request | $0.10 |
| **Estimated total** | | | **~$1.92** |

*Actual cost varies with video quantity, quality tier (tier-formulas multipliers), and frame sampling density. Budget is configurable per event (default in `DEFAULT_EVENT_BUDGET_USD` env var).*