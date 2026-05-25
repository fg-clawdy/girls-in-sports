# PRD: Sprint 1 — Smart Video Segmentation & Accurate Scoring

**Version:** 2.0  
**Date:** 2026-05-24  
**Status:** FINAL  
**Project:** Girls In Sports (GIS) AI Highlight Engine  
**Sprint Goal:** Vastly improve analysis accuracy and media clipping so every uploaded video — regardless of length — is automatically decomposed into meaningful, individually-scored highlight clips before any downstream curation or rendering.

**Revision Note (v2.0):** Incorporates user feedback on three additional requirements: dual-path transcription (Venice beta /audio/transcribe primary → Whisper fallback with diarization), user-selectable campaign music model (default minimax-music-v26, ElevenLabs labeled [expensive - $1.25]), and tiered frame-rate strategy (3 fps ACTION, 1 fps SPEECH, capped at 120 frames per clip). Original segmentation + scoring scope preserved and refined.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current State Analysis](#2-current-state-analysis)
3. [Goals & Non-Goals](#3-goals--non-goals)
4. [User Stories](#4-user-stories)
5. [Functional Requirements](#5-functional-requirements)
6. [Technical Architecture](#6-technical-architecture)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Schema Changes](#8-schema-changes)
9. [Implementation Plan](#9-implementation-plan)
10. [Success Metrics](#10-success-metrics)
11. [Risks & Mitigations](#11-risks--mitigations)

---

## 1. Problem Statement

Users upload raw, unedited sports videos — ranging from 10-second action bursts to 5-minute continuous recordings — and expect the AI to produce a polished 60-second highlight reel. Today, the pipeline fails at the foundational step: videos are ingested whole, scored as monolithic units, and never decomposed into discrete moments. This creates cascading failures:

**A. Scoring Collapse** — A 3-minute baseball at-bat video containing one spectacular 15-second hit-and-run receives a diluted composite score identical to that of a 10-second generic action clip. The scoring algorithm punishes interesting videos that happen to be long.

**B. No Clip Isolation** — The "scene detection" step exists in schema and code stubs but does not produce real child `Asset` records with `type=CLIP` from long source videos. Without discrete clips, the composer has nothing meaningful to select from and defaults to full-source-video segments.

**C. Missed Signal in Low-Motion Content** — A coach's 90-second motivational speech contains emotionally powerful moments that would score highly if isolated. Because the whole speech is scored together, the audio signal (powerful words, vocal intensity, key phrases) is averaged out and the clip may not make the cut at all.

**D. Fixed Frame Sampling Wastes Tokens, Misses Peaks** — The current vision analysis uses a fixed frame count (3–12 frames) regardless of content. A 30-second dunk clip gets 12 frames (0.4 fps) — missing the exact moment of ball contact. A 90-second speech gets identical treatment — wasting AI tokens on near-identical frames of a static speaker.

**E. Transcription is Single-Path, No Diarization** — Whisper provides word-level timestamps but cannot distinguish speakers. Coach quotes are weighted identically to background parent chatter. Venice's beta `/audio/transcribe` endpoint offers speaker diarization and higher accuracy — but is not integrated.

**F. Music Model Selection is Hardcoded** — Users cannot choose between cost tiers (ElevenLabs $1.25 vs Minimax ~$0.10). The handler tries `elevenlabs-music` first with an obsolete `ace-step` fallback that always fails.

The sprint goal is to fix all six problems before any downstream curation, rendering, or highlight assembly is attempted.

## 2. Current State Analysis

### 2.1 Existing Pipeline (What Works)

| Step | Handler/Service | Status |
|------|----------------|--------|
| Event creation | `POST /api/events` | ✅ Working |
| Media upload | `POST /api/events/[id]/upload` | ✅ Working |
| Job queuing | `job-worker.ts` + `worker.ts` | ✅ Working |
| Ingest clip | `handlers/ingest-clip.ts` | ⚠️ Partial — metadata only; no segmentation |
| Scene detection | `scene-detection-service.ts` | ❌ Not producing child Assets |
| Score clip | `handlers/score-clip.ts` | ⚠️ Scores full video, not clips; fixed frame count |
| Vision analysis | `vision.ts` | ⚠️ Fixed 3–12 frames regardless of content |
| Audio/STT | score-clip.ts transcribeVideo() | ⚠️ Whisper only; no diarization; no beta endpoint |
| Audio scoring | score-clip.ts computeAudioScore() | ⚠️ Keyword-match only; no speech intensity metric |
| Music generation | `handlers/generate-music.ts` | ⚠️ Hardcoded model: elevenlabs-music → ace-step |
| Direct script | `handlers/direct-script.ts` | ✅ Works once clips exist |
| Render proxy/final | `handlers/render-proxy/final.ts` | ✅ Works once clips exist |

### 2.2 Scoring Collapse Detail

`score-clip.ts` receives an Asset and runs vision + audio analysis on the whole file. The `momentScore` and `productionScore` returned by the LLM vision call average over all sampled frames. A 3-minute video with 40 dull frames and 5 excellent frames will average to a mediocre score. The fix requires scoring to operate on child clips, not source videos.

### 2.3 Frame Sampling Detail

Current code (`score-clip.ts` lines 119–127):
- ACTION/MIXED ≤10s: **6 frames** (0.6 fps)
- ACTION/MIXED >10s: **12 frames** (0.4–1.2 fps)
- SPEECH/MONTAGE: **3–6 frames** (fixed)
- Batch size: **3 frames per Venice API call**

At 0.6 fps for a 15-second dunk clip, frames are spaced 2.5 seconds apart — easily missing the 300ms peak of a slam dunk.

### 2.4 Transcription Detail

Current code (`score-clip.ts` transcribeVideo, lines 308–397):
- Downloads video, extracts WAV, sends to `/{VENICE_URL}/audio/transcriptions` with `model: "openai/whisper-large-v3"` and `timestamps=true`
- Parses `data.timestamps.word` array for word-level timing
- Groups words into segments by pause >1.5s or >12 words
- No speaker diarization — all speech is anonymous
- No attempt to use Venice's beta `/audio/transcribe` endpoint

### 2.5 Music Model Detail

Current code (`generate-music.ts` lines 74–101):
- Hardcoded: tries `elevenlabs-music` first, falls back to `ace-step`
- `ace-step` is not in the type union (`music-generation.ts` line 12) — likely always fails
- No `Campaign.musicModel` field — model selection is invisible to users
- No per-campaign override; no cost tier labeling

## 3. Goals & Non-Goals

### 3.1 Goals (Sprint 1 Scope)

1. **Smart Segmentation** — Every source video longer than a configurable threshold (default: 20 seconds) is automatically split into discrete child `Asset` records (`type=CLIP`) during ingest. Short videos (≤20s) are treated as a single clip and pass through unchanged.

2. **Dual-Path Transcription with Diarization** — Venice beta `/audio/transcribe` as primary (speaker diarization, higher accuracy). Whisper `/audio/transcriptions` as automatic fallback on beta failure. Diarized speaker labels feed into scoring: coach voice weighted higher than background speech.

3. **Content-Aware Dynamic Frame Sampling** — Vision analysis uses a tiered FPS strategy based on clip type and duration: ACTION/MIXED clips sampled at 3 fps (capped at 120 frames), SPEECH/MONTAGE clips at 1 fps (capped by duration). Batch size increased from 3 to 6 frames per Venice API call.

4. **Per-Clip Scoring** — Scoring (`score-clip`) runs on each child clip independently, not on the raw source video. Each clip receives its own `momentScore`, `productionScore`, and composite.

5. **Audio-Signal Rescue** — Low-motion clips with high-signal audio (coach speech, celebration, crowd roar, impactful quotes) are identified and scored with a boosted audio weight so they are not automatically discarded. Speech clips use 70/30 audio/visual weight split.

6. **Transcript-Driven Speech Segmentation** — For speech-dominant videos, word-level transcription timestamps and diarized speaker segments drive clip boundaries so individual sentences or emotional arcs become discrete clips.

7. **User-Selectable Music Model** — Campaign creation UI lets user pick music model: `minimax-music-v26` (default, ~$0.10), `elevenlabs-music` (labelled `[expensive - $1.25 per]`), with optional `minimax-music-v2`/`minimax-music-v25`. Model selection stored in `Campaign.musicModel` and respected by `generate-music.ts`.

### 3.2 Non-Goals (Out of Sprint 1 Scope)

- UI changes to the clip curation or campaign screens beyond the music model selector
- Rendering or final video assembly improvements
- Beat-sync changes (already implemented in US-012)
- Upscaling or resolution improvements
- Multi-user or permissions work
- Cost budget changes (existing budget guard stays unchanged — per-clip costs covered by existing `estimateScoreClipCost`)

## 4. User Stories

### US-S1-01: Smart Video Segmentation During Ingest

**As a** user who uploads a 3-minute baseball at-bat video,  
**I want** the AI to automatically detect and split it into discrete clips (e.g., "pitch taken", "swing and miss", "foul ball", "hit and run"),  
**So that** each moment is scored independently and the spectacular final play scores highly on its own merits.

**Acceptance Criteria:**
- Source videos >20 seconds are segmented into child CLIP Assets during INGEST_CLIP
- Each child Asset has a valid `parentAssetId`, `startTimeMs`, `endTimeMs`, `durationSeconds`, `motionLevel`, `dominantMode`
- Child clips are individually queued for `SCORE_CLIP` jobs
- The original source Asset status is set to `INGESTING` while children process, then `SCORED` when all children complete
- Videos ≤20 seconds produce a single child clip (effectively a passthrough)
- Minimum clip length is configurable (default: 4 seconds); very short segments are merged with adjacent clips
- Maximum clips per source: 20 (configurable); excess segments merged by motion-profile proximity

---

### US-S1-02: Dual-Path Transcription with Venice Beta Primary + Whisper Fallback

**As a** user who films a coach giving a 90-second motivational speech alongside parent commentary,  
**I want** the AI to transcribe using Venice's beta `/audio/transcribe` endpoint with speaker diarization, falling back to Whisper if the beta is unavailable,  
**So that** coach quotes can be identified by speaker, weighted more heavily in audio scoring, and isolated into their own high-scoring clips.

**Acceptance Criteria:**
- `transcribeVideo()` updated to try Venice beta `/audio/transcribe` first (same base URL, same API key)
- If beta succeeds and returns diarized segments: speaker labels stored alongside transcript words
- Coach-speaker heuristic applied: segments with directive words + longer utterances classified as "coach" speaker
- If beta fails (non-2xx, timeout, no diarization): fall back to Whisper `/audio/transcriptions` (current behavior preserved exactly)
- Fallback is logged with a quality flag (`transcriptionFallback: true`)
- Diarized speaker info feeds into `audioScore`: coach-identified speech segments weighted 2× vs. unidentified speech
- Quality flag records which transcription path was used: `transcriptionProvider: "venice-beta" | "whisper-fallback"`

**Reference:** Venice beta docs at https://docs.venice.ai/api-reference/endpoint/audio/transcriptions — same base URL, same API key.

---

### US-S1-03: Transcript-Driven Speech Clip Segmentation

**As a** user who films a coach giving a 90-second motivational speech,  
**I want** the AI to use word-level transcription timestamps (and diarized speaker segments) to split the speech into individual clips by sentence or emotional arc,  
**So that** a particularly powerful quote is isolated as its own clip and can score high enough to appear in the final highlight reel.

**Acceptance Criteria:**
- When STT produces word-level timestamps and motion level is LOW for ≥3 consecutive seconds, speech segmentation mode activates
- Sentence-boundary detection (silence gaps ≥0.8s OR punctuation inference) defines clip boundaries
- Diarized speaker changes also trigger segment boundaries (new speaker = potential new clip)
- Each speech clip carries a `transcriptExcerpt` in its ClipScore (scoped to that clip's time window)
- Speech clips are classified as `ClipType.SPEECH`
- Audio signal score (keyword intensity, vocal energy, speaker weight) is applied at 70% for SPEECH clips (vs. 30% visual)

---

### US-S1-04: Content-Aware Dynamic Frame Sampling

**As a** developer and system operator,  
**I want** the vision analysis to sample frames at a consistent per-second rate based on clip type and motion profile,  
**So that** ACTION clips get dense temporal coverage (3 fps) while SPEECH clips conserve tokens, and no clip exceeds a hard frame budget.

**Acceptance Criteria:**

**Frame Density Rules (Tiered FPS Strategy):**

| Clip Duration | ACTION/MIXED fps | SPEECH/MONTAGE fps | Hard Cap (frames) |
|--------------|------------------|--------------------|--------------------|
| 0–10 sec | 3 fps | 1 fps | 30 |
| 10–30 sec | 3 fps | 1 fps | 90 |
| 30–60 sec | 2 fps | 0.5 fps | 120 |
| 60+ sec | 2 fps | 0.5 fps | 120 |

- **Absolute maximum:** 120 frames per clip (prevents runaway cost on very long videos)
- **Batch size:** Increased from 3 to **6 frames per Venice API call** (doubles throughput, well within model context window)
- **SPEECH clips:** 1 fps max (sufficient for framing/production quality check; audio carries scoring weight)
- **Edge case:** If duration * fps would exceed cap, density is reduced proportionally while preserving evenly-spaced coverage
- Frame extraction uses ffmpeg `-ss` seek with absolute timestamps (no whole-file decode) for efficiency
- `MAX_FRAMES_PER_CLIP` configurable via environment variable (default: 120)

**Cost Model (Venice vision @ ~$0.015/frame):**

| Clip Type | Duration | Frames | API Calls (6/batch) | Est. Cost |
|-----------|----------|--------|---------------------|-----------|
| ACTION | 15s | 45 | 8 | $0.68 |
| ACTION | 30s | 90 | 15 | $1.35 |
| SPEECH | 30s | 30 | 5 | $0.45 |
| SPEECH | 90s | 45 | 8 | $0.68 |

---

### US-S1-05: Per-Clip Isolated Scoring

**As a** user,  
**I want** each clip to be scored based solely on its own content,  
**So that** a 15-second spectacular hit is not dragged down by the 2 minutes of setup footage it was filmed alongside.

**Acceptance Criteria:**
- `SCORE_CLIP` jobs target child CLIP Assets, not SOURCE_VIDEO Assets
- `score-clip` handler skips any SOURCE_VIDEO Asset that has `childAssets.length > 0` (idempotency guard)
- Each child clip receives an independent `momentScore`, `productionScore`, and composite
- SOURCE_VIDEO composite is computed as `max(childComposites)` for display purposes only (not used in curation selection)
- Clip-level transcript words (scoped to the clip's time window) are stored in `transcriptWordsJson` on the child Asset

---

### US-S1-06: Audio-Signal Rescue for Low-Motion Clips

**As a** user,  
**I want** quiet, low-motion clips that contain emotionally important audio to still make the highlight reel,  
**So that** a coach's best quote or a victory cheer doesn't get filtered out because the camera wasn't moving.

**Acceptance Criteria:**
- Low-motion clips (motion level = LOW) are not auto-excluded from scoring
- **Audio rescue rule:** If `audioScore ≥ 60` on a LOW-motion clip, `momentScore` floor is lifted to 40 (preventing elimination by motion absence alone)
- LOW motion + `audioScore < 40` → no floor applied (clip is genuinely uninteresting)
- Clips with `hasCoachSpeech=true` or `hasActionKeyword=true` are tagged
- **SPEECH ClipType formula:** `momentScore = 0.3 × visualMoment + 0.7 × audioSignal` (applied in `score-clip.ts`)
- SPEECH clips get a `speechIntensityScore` stored in ClipScore (derived from vocal energy RMS variance, keyword density, and coach-speaker weighting from diarization)

---

### US-S1-07: User-Selectable Music Model per Campaign

**As a** curator creating a campaign,  
**I want** to choose between cost tiers for background music generation,  
**So that** I can opt for premium ElevenLabs quality when budget allows, or use the more affordable Minimax default.

**Acceptance Criteria:**

- `Campaign` model gains new field `musicModel String?` (nullable; null = use default)
- Default music model: `minimax-music-v26` (set via env `DEFAULT_MUSIC_MODEL`, configurable)
- Available models displayed to user at campaign creation:
  - `minimax-music-v26` — Default, fast, ~$0.10 per track
  - `elevenlabs-music` — `[expensive - $1.25 per]` — premium quality
  - `minimax-music-v2` — Legacy, ~$0.10
  - `minimax-music-v25` — Legacy, ~$0.10
- `generate-music.ts` reads `campaign.musicModel` and passes it to `queueMusicGeneration()`
- If `campaign.musicModel` is null/undefined: uses `DEFAULT_MUSIC_MODEL` env var (or `minimax-music-v26` hardcode)
- Removed: obsolete `ace-step` fallback in `generate-music.ts` line 87 (not in type union; always fails)
- If selected model fails: fall back to `DEFAULT_MUSIC_MODEL` (not hardcoded to elevenlabs)
- Music model choice is visible in `Campaign.musicModel` on the campaign detail API
- UI on campaign creation page: dropdown or radio group for music model selection with cost labels

---

### US-S1-08: Schema Migration, Tests, Typecheck, and PRD Update

**Files:** `prisma/schema.prisma`, new migration, `__tests__/sprint1-segmentation.test.ts` (new)  
**Work:**
- Add `motionLevel`, `dominantMode`, `transcriptWordsJson` to Asset
- Add `speechIntensityScore`, `motionLevel` to ClipScore
- Add `musicModel` to Campaign
- Run `prisma migrate dev --name add_smart_segmentation_fields`
- Update `.env.example` with new variables
- Consolidate all unit tests
- `npm run typecheck` clean
- Update this PRD with implementation log

## 5. Functional Requirements

### 5.1 Video Segmentation Engine (`video-segmentation.ts` — Rewrite)

**FR-01** The segmentation engine MUST accept a source video file path and return an ordered array of segments: `{ startMs: number; endMs: number; motionLevel: 'LOW'|'MEDIUM'|'HIGH'; dominantMode: 'ACTION'|'SPEECH'|'MIXED' }`.

**FR-02** Motion level MUST be computed using ffmpeg `select` filter with inter-frame difference scoring. No additional paid AI calls for motion detection.

**FR-03** Segments MUST be merged if shorter than `MIN_CLIP_DURATION_MS` (default 4000ms) by absorbing the shorter segment into the adjacent segment with the closest motion profile.

**FR-04** Maximum segment count per source video is `MAX_CLIPS_PER_SOURCE` (default: 20). If detection produces more, the lowest-motion adjacent segments are merged until the count is within limit.

**FR-05** The engine MUST detect "speech mode" when: (a) motion level is LOW for ≥3 consecutive seconds AND (b) audio amplitude RMS is above the configurable `VAD_RMS_THRESHOLD`. In speech mode, segment boundaries are refined using transcript word timestamps from US-S1-02.

**FR-06** Segment boundaries MUST snap to the nearest keyframe (I-frame) within ±500ms to ensure clean cuts without re-encoding artifacts.

---

### 5.2 Transcription Service (`score-clip.ts` transcribeVideo — Extend)

**FR-07** `transcribeVideo()` MUST attempt Venice beta `/audio/transcribe` as primary path, using same base URL and same API key as current Venice setup.

**FR-08** Beta response MUST be parsed for: full transcript text, word-level timestamps, and speaker diarization segments (if available). Speaker labels stored alongside word data.

**FR-09** If beta fails (non-2xx, timeout >30s, or response lacks expected structure): MUST fall back to Whisper `/audio/transcriptions` with identical parameters as current production code. Fallback MUST be logged with `transcriptionFallback: true` quality flag.

**FR-10** Coach-speaker identification heuristic: speaker segments with ≥20 words AND containing ≥2 directive words (from `SPORT_KEYWORDS`) are classified as "coach" — these segments receive 2× audio weight.

**FR-11** `transcribeVideo()` MUST return an enriched result including: `transcript`, `segments`, `words`, `speakers` (array of `{ speakerLabel, segments }`), and `provider` ("venice-beta" | "whisper-fallback").

---

### 5.3 Ingest Handler Updates (`handlers/ingest-clip.ts` — Extend)

**FR-12** After metadata extraction and STT transcription, `ingest-clip` MUST call the segmentation engine on every `SOURCE_VIDEO` Asset with `childAssets.length === 0`.

**FR-13** For each returned segment, `ingest-clip` MUST create a child `Asset` record with: `type='CLIP'`, `parentAssetId=sourceAsset.id`, `eventId`, `startTimeMs`, `endTimeMs`, `durationSeconds`, `motionLevel`, `dominantMode`, `status='UPLOADED'`, and `transcriptWordsJson` (scoped to clip time window if STT available).

**FR-14** After all child Assets are created, `ingest-clip` MUST enqueue one `SCORE_CLIP` job per child clip.

**FR-15** The parent SOURCE_VIDEO Asset status MUST be updated to `INGESTING` while children are being processed, then to `SCORED` once all child SCORE_CLIP jobs complete.

---

### 5.4 Dynamic Frame Sampler (`score-clip.ts` extractKeyframes — Extend)

**FR-16** Frame extraction MUST use the tiered FPS strategy defined in US-S1-04 AC table.

**FR-17** `MAX_FRAMES_PER_CLIP` (default 120) configurable via environment variable. When density rules would exceed this cap, reduce proportionally preserving even coverage.

**FR-18** Batch size for Venice vision API calls MUST be 6 frames (up from 3). Each batch sent as one `/chat/completions` call.

**FR-19** For SPEECH clips (`dominantMode = 'SPEECH'` or `clipType = SPEECH`): max 1 fps (sufficient for production quality check).

---

### 5.5 Score Clip Handler Updates (`handlers/score-clip.ts` — Extend)

**FR-20** `score-clip` MUST skip any Asset with `type='SOURCE_VIDEO'` that has child CLIP Assets. Only child CLIPs are scored.

**FR-21** For SPEECH clips, the scoring formula MUST apply a modified weight: `momentScore = 0.3 × visualMoment + 0.7 × audioSignal`. For ACTION and MIXED clips, the standard `tier-formulas.ts` weights apply.

**FR-22** After scoring a child clip, `score-clip` MUST check if all sibling clips (same `parentAssetId`) are scored. When all are done, it updates the parent SOURCE_VIDEO's `compositeScore` to `max(sibling compositeScores)` via an upsert on ClipScore.

**FR-23** `audioScore` computation MUST incorporate speaker weighting from diarization: coach-identified segments weighted 2× vs. unrecognized speech.

**FR-24** Quality flags on the SCORE_CLIP job MUST include: `transcriptionProvider` ("venice-beta" | "whisper-fallback"), `transcriptionFallback` (boolean), `visionFailedBatches`, `visionUsedFallback`.

---

### 5.6 Music Model Selection (`generate-music.ts` — Extend, Campaign model — Extend)

**FR-25** `Campaign` model MUST gain `musicModel` field (nullable String) — default null means "use system default."

**FR-26** `generate-music.ts` MUST read `campaign.musicModel` and use it for `queueMusicGeneration()` model parameter. If null/undefined, use `DEFAULT_MUSIC_MODEL` env var or hardcoded `minimax-music-v26`.

**FR-27** The obsolete `ace-step` fallback (line 87) MUST be removed. Fallback on model failure MUST use `DEFAULT_MUSIC_MODEL`.

**FR-28** Campaign creation UI MUST expose music model selection dropdown with cost labels: `minimax-music-v26` ("Default"), `elevenlabs-music` ("Premium — $1.25/track"), `minimax-music-v2`, `minimax-music-v25`.

---

## 6. Technical Architecture

### 6.1 Updated Pipeline Flow

```
UPLOAD
  │
  ▼
INGEST_CLIP Job
  ├── Extract metadata (ffprobe)
  ├── Run STT transcription (dual-path)
  │     ├── Primary: Venice beta /audio/transcribe → diarized speakers
  │     └── Fallback: Whisper /audio/transcriptions (current behavior)
  ├── Run motion analysis pass (ffmpeg frame-diff)
  ├── Call segmentVideo(transcriptWords, speakers) → returns segments[]
  ├── For each segment:
  │     ├── Create child Asset (type=CLIP, parentAssetId, startTimeMs, endTimeMs,
  │     │                         motionLevel, dominantMode, transcriptWordsJson)
  │     └── Enqueue SCORE_CLIP job for child Asset
  └── Update parent Asset.status = INGESTING
        │
        ▼
  SCORE_CLIP Job (per child CLIP Asset)
    ├── Determine clip motionLevel & dominantMode from stored metadata
    ├── sampleFramesDynamic() → frame timestamps (3 fps ACTION, 1 fps SPEECH, cap 120)
    ├── Extract frames in batches of 6 (ffmpeg -ss seek to startMs + offset)
    ├── Vision LLM calls (batched 6 frames/call) → momentScore (visual), productionScore
    ├── Audio analysis (windowed: startMs→endMs) → audioScore
    │     └── If SPEECH: speechIntensityScore with speaker weighting
    ├── Apply scoring formula:
    │     ACTION/MIXED → tier-formulas.ts standard weights
    │     SPEECH → 30% visual / 70% audio (coach segments 2× weighted)
    │     Audio rescue: if LOW motion + audioScore≥60, lift momentScore floor to 40
    ├── Upsert ClipScore for child Asset (with speechIntensityScore, motionLevel)
    ├── Record quality flags (transcriptionProvider, visionFailedBatches)
    ├── Check if all siblings scored
    │     └── If yes: upsert parent SOURCE_VIDEO ClipScore.composite = max(children)
    │     └── Update parent Asset.status = SCORED
    └── Tag child Asset (hasCoachSpeech, hasActionKeyword, clipType)
```

### 6.2 Key Files Modified / Created

| File | Change Type | Summary |
|------|-------------|---------|
| `src/lib/video-segmentation.ts` | **Rewrite** | Real motion analysis + segment output with transcript-driven refinement |
| `src/lib/handlers/ingest-clip.ts` | **Extend** | Call segmentation, create child Assets with motionLevel/dominantMode/transcriptWordsJson, enqueue child SCORE_CLIP jobs |
| `src/lib/handlers/score-clip.ts` | **Major Extend** | Dual-path transcription (beta primary → Whisper fallback), dynamic frame sampling (3 fps / 1 fps / cap 120), SPEECH formula (70/30), audio rescue, sibling rollup, diarization-weighted audioScore, batch size 6 |
| `src/lib/handlers/generate-music.ts` | **Extend** | Read campaign.musicModel, remove ace-step fallback, fall back to DEFAULT_MUSIC_MODEL |
| `src/lib/vision.ts` | **No changes** | Dynamic frame logic lives in score-clip.ts extractKeyframes (already handles scene-aware extraction) |
| `src/lib/audio-analysis.ts` | **Extend** | Windowed audio analysis with startMs/endMs, computeSpeechIntensityScore with speaker weighting |
| `src/lib/scene-detection-service.ts` | **Deprecate/Remove** | Logic absorbed into `video-segmentation.ts` |
| `prisma/schema.prisma` | **Extend** | Asset: +motionLevel, +dominantMode, +transcriptWordsJson; ClipScore: +speechIntensityScore, +motionLevel; Campaign: +musicModel |
| Campaign creation UI | **Extend** | Music model selector dropdown with cost labels |

### 6.3 Dual-Path Transcription Architecture

```
transcribeVideo(videoPath)
  │
  ├─ Step 1: Extract audio to WAV (16kHz mono) — same as current
  │
  ├─ Step 2: Try Venice Beta /audio/transcribe
  │    ├─ POST {VENICE_URL}/audio/transcribe
  │    ├─ Headers: Authorization Bearer {VENICE_KEY}
  │    ├─ Body: FormData { file, model: "venice-transcribe-beta" }
  │    ├─ Parse response for:
  │    │   ├─ text (full transcript)
  │    │   ├─ words[] (word-level timestamps)
  │    │   └─ speakers[] (speaker_label, segments[]) — diarization
  │    ├─ If success + has diarization:
  │    │   └─ Return enriched result (provider: "venice-beta")
  │    └─ If failure (non-2xx, timeout, no diarization):
  │       └─ Log warning, proceed to fallback
  │
  └─ Step 3: Fallback to Whisper /audio/transcriptions
       ├─ Same as current code (openai/whisper-large-v3)
       ├─ Parse words from data.timestamps.word
       └─ Return standard result (provider: "whisper-fallback")
```

### 6.4 Frame Extraction for Child Clips

Because child Assets reference the parent's file via time window (not physically split), frame extraction uses ffmpeg seeking:

```
ffmpeg -ss {absoluteStartSec} -i {parentFilePath} -t {clipDurationSec} \
       -vf "select=..." -vsync 0 frame_%d.jpg
```

This is zero-copy — no intermediate video files are created. The existing `cutWindow()` helper in score-clip.ts (lines 708–739) already does this for legacy child scenes; the same approach extends to all child clips.

### 6.5 Backward Compatibility

- Existing SOURCE_VIDEO Assets that already have child CLIPs (from previous runs) are detected by checking `childAssets.length > 0` — ingest skips re-segmentation.
- Legacy `SceneSegment` records (deprecated model) are unaffected; the migration script in `scripts/migrate-legacy-scenes-to-child-assets.ts` continues to work for historical data.
- The `resolveSceneCut` utility in `src/lib/resolve-scene-cut.ts` already handles child Asset time resolution for renders — no render changes needed in this sprint.
- Existing campaigns without `musicModel` will use the new default `minimax-music-v26` (not the old elevenlabs-first behavior).

## 7. Acceptance Criteria (Full Sprint)

### AC-01: Segmentation Produces Child Assets
- Given a SOURCE_VIDEO Asset with `durationSeconds > 20`, after INGEST_CLIP completes, `childAssets` MUST contain ≥ 2 CLIP Assets with non-overlapping time windows that cover the full source duration
- Given a SOURCE_VIDEO Asset with `durationSeconds ≤ 20`, after INGEST_CLIP completes, `childAssets` MUST contain exactly 1 CLIP Asset spanning the full video

### AC-02: No Child Asset Has Duration < 4s
- Every child CLIP Asset MUST have `(endTimeMs - startTimeMs) ≥ 4000`

### AC-03: Child SCORE_CLIP Jobs Are Enqueued
- For each child CLIP Asset created, exactly one `SCORE_CLIP` job with `payload.assetId = child.id` MUST exist in the Jobs table after ingest

### AC-04: Dual-Path Transcription Works
- `transcribeVideo()` tries Venice `/audio/transcribe` first; on success, returns diarized speakers and `provider: "venice-beta"`
- On beta failure (simulated via bad URL or 500), falls back to `/audio/transcriptions` with `provider: "whisper-fallback"`
- Diarized coach segments receive 2× weight in `computeAudioScore()`

### AC-05: Frame Counts Are Dynamic
- A 30-second LOW-motion/SPEECH clip MUST produce ≤ 30 extracted frames (1 fps)
- A 15-second HIGH-motion ACTION clip MUST produce 45 extracted frames (3 fps)
- No clip MUST ever produce > 120 frames for a vision call
- Venice API calls batch 6 frames each (not 3)

### AC-06: SPEECH Clips Score with Audio-Dominant Formula
- A CLIP with `clipType = SPEECH` and `audioScore = 80`, `visualMoment = 30` MUST produce `momentScore ≈ 65` (0.3 × 30 + 0.7 × 80 = 65)
- The same clip scored as ACTION would produce `momentScore ≈ 45` (0.5 × 30 + 0.3 × 80 + 0.2 × motion) — confirming SPEECH formula is applied

### AC-07: Audio Rescue Prevents Elimination
- A CLIP with `motionLevel = LOW` and `audioScore = 65` MUST have its `momentScore` floored to ≥ 40 in the final ClipScore
- A CLIP with `motionLevel = LOW` and `audioScore = 40` MUST NOT receive the floor lift (stays at natural visual score)

### AC-08: Parent SOURCE_VIDEO Rolls Up Max Score
- After all child CLIP Assets are scored, the parent SOURCE_VIDEO's `ClipScore.compositeScore` MUST equal `max(child compositeScores)` — not an average

### AC-09: Music Model Selection Works
- `Campaign.musicModel` field exists and accepts `minimax-music-v26` (default), `elevenlabs-music`, `minimax-music-v2`, `minimax-music-v25`
- `generate-music.ts` reads `campaign.musicModel` and passes it to `queueMusicGeneration()`
- ElevenLabs model labeled `[expensive - $1.25 per]` in UI
- Obsolete `ace-step` fallback removed from `generate-music.ts`
- On selected model failure, falls back to `DEFAULT_MUSIC_MODEL` (not hardcoded to elevenlabs)

### AC-10: TypeScript Typecheck Passes
- `npm run typecheck` produces zero new errors (pre-existing pino type warning ignored per SKILL.md)

### AC-11: Tests Pass
- `__tests__/sprint1-segmentation.test.ts` (new) covers: segment merging, min-duration enforcement, speech mode activation, dynamic frame count computation (3 fps / 1 fps / cap 120), audio rescue floor logic, sibling rollup, dual-path transcription with diarization, music model selection
- All existing tests in `__tests__/` continue to pass

### AC-12: Backward Compatibility
- An existing SOURCE_VIDEO with `childAssets.length > 0` is NOT re-segmented on re-ingest
- Renders using `resolveSceneCut` continue to work correctly for both legacy and new child Assets
- Campaigns without `musicModel` default to `minimax-music-v26`

## 8. Schema Changes

### 8.1 Asset Model — New Fields

```prisma
model Asset {
  // ... existing fields ...
  motionLevel         String?   // 'LOW' | 'MEDIUM' | 'HIGH' — set during ingest segmentation
  dominantMode        String?   // 'ACTION' | 'SPEECH' | 'MIXED' — set during ingest segmentation
  transcriptWordsJson  Json?    // Array of {word, startMs, endMs, speakerLabel?} scoped to this clip's time window
}
```

**Migration:** Non-breaking additions (nullable columns). `prisma db push` or standard migration.

### 8.2 ClipScore Model — New Fields

```prisma
model ClipScore {
  // ... existing fields ...
  speechIntensityScore Float?  @map("speechintensityscore")  // 0-100, only populated for SPEECH clips
  motionLevel          String? @map("motionlevel")           // denormalized from Asset for fast querying
}
```

### 8.3 Campaign Model — New Field

```prisma
model Campaign {
  // ... existing fields ...
  musicModel           String?   // 'minimax-music-v26' | 'elevenlabs-music' | 'minimax-music-v2' | 'minimax-music-v25' | null (default)
}
```

### 8.4 No New Tables Required

The existing `Asset` parent/child pattern, `ClipScore`, `AssetTag`, and `Job` models are sufficient. No new tables needed in this sprint.

### 8.5 Environment Variables (New & Modified)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEGMENTATION_THRESHOLD_SECONDS` | `20` | Source videos longer than this are segmented |
| `MIN_CLIP_DURATION_MS` | `4000` | Minimum clip length before merging |
| `MAX_CLIPS_PER_SOURCE` | `20` | Maximum child clips per source video |
| `MAX_FRAMES_PER_CLIP` | `120` | Frame budget cap for vision LLM calls (up from 24) |
| `SILENCE_BOUNDARY_MS` | `800` | Silence gap that triggers a segment boundary |
| `VAD_RMS_THRESHOLD` | `0.05` | Voice activity detection RMS threshold |
| `MOTION_LOW_THRESHOLD` | `0.05` | ffmpeg scene score below this = LOW motion |
| `MOTION_HIGH_THRESHOLD` | `0.20` | ffmpeg scene score above this = HIGH motion |
| `DEFAULT_MUSIC_MODEL` | `minimax-music-v26` | Default music model for new campaigns |
| `VENICE_BETA_TRANSCRIBE` | `true` | Enable Venice beta /audio/transcribe (set false to skip) |

## 9. Implementation Plan

### Story Order (Sequential — each must typecheck + test before proceeding)

#### Story S1-01: Real Video Segmentation Engine
**Files:** `src/lib/video-segmentation.ts` (rewrite)  
**Work:**
- Implement ffmpeg scene-filter motion scoring pass
- Implement boundary detection (motion tier change + silence gap)
- Implement I-frame snapping
- Implement segment merging (min duration + max count)
- Implement speech mode detection (LOW motion + VAD threshold)
- Accept transcript words + diarized speakers for speech refinement
- Export `segmentVideo(filePath, transcriptWords?, speakers?) → Segment[]`

**Tests:** segment merging, min-duration, max-count cap, speech mode activation, speech refinement with transcript

---

#### Story S1-02: Dual-Path Transcription with Diarization
**Files:** `src/lib/handlers/score-clip.ts` (`transcribeVideo()` rewrite)  
**Work:**
- Add Venice beta `/audio/transcribe` primary path with FormData POST
- Parse diarized speakers from beta response
- Implement coach-speaker heuristic (≥20 words + ≥2 directive keywords)
- Preserve Whisper fallback with identical behavior
- Return enriched result with `speakers[]` and `provider` field
- Log `transcriptionFallback` quality flag on beta failure

**Tests:** beta success path, fallback on 500, fallback on timeout, diarization parsing, coach identification

---

#### Story S1-03: Ingest Handler — Segmentation + Transcript Integration
**Files:** `src/lib/handlers/ingest-clip.ts` (extend)  
**Work:**
- After STT, call `segmentVideo()` with transcript words + speaker data
- Create child Asset records per segment with `motionLevel`, `dominantMode`, `transcriptWordsJson`
- Skip if `childAssets.length > 0` (idempotency)
- Enqueue `SCORE_CLIP` job per child clip
- Set parent status to `INGESTING`

**Tests:** child asset creation, idempotency guard, job enqueue count, transcriptWordsJson scoping

---

#### Story S1-04: Dynamic Frame + Windowed Audio + Speech Intensity
**Files:** `src/lib/handlers/score-clip.ts` (extend `extractKeyframes`), `src/lib/audio-analysis.ts` (extend)  
**Work:**
- Implement tiered FPS strategy in `extractKeyframes()` (3 fps ACTION, 1 fps SPEECH, cap 120)
- Increase batch size to 6 frames per Venice call
- Add `startMs`/`endMs` parameters to audio analysis entry point
- Add `computeSpeechIntensityScore(transcript, audioRmsVariance, keywords, speakerWeights) → number`
- Implement VAD RMS threshold check

**Tests:** frame counts at each motion level, cap enforcement, SPEECH cap, batch size, windowed audio vs. full-file, speechIntensityScore range 0–100, speaker-weighted scoring

---

#### Story S1-05: Score Clip — Per-Clip Scoring + SPEECH Formula + Sibling Rollup
**Files:** `src/lib/handlers/score-clip.ts` (extend handler logic)  
**Work:**
- Skip SOURCE_VIDEO with children (guard clause)
- Pass `startMs`/`endMs` to vision and audio calls
- Apply SPEECH formula (30/70 split) with diarization-weighted audio component
- Apply audio rescue floor (LOW motion + audioScore ≥ 60 → momentScore floor 40)
- After upsert, query siblings; if all scored → upsert parent SOURCE_VIDEO composite = max
- Populate `speechIntensityScore` and `motionLevel` on ClipScore
- Record quality flags (transcriptionProvider, visionFailedBatches)

**Tests:** SPEECH formula output, audio rescue threshold, sibling rollup correctness, SOURCE_VIDEO skip, quality flags

---

#### Story S1-06: User-Selectable Music Model
**Files:** `src/lib/handlers/generate-music.ts`, `prisma/schema.prisma`, campaign creation UI  
**Work:**
- Add `musicModel` to Campaign model, run migration
- Update `handleGenerateMusic()` to read `campaign.musicModel`
- Remove `ace-step` fallback (line 87)
- Fall back to `DEFAULT_MUSIC_MODEL` on failure
- Campaign creation API accepts `musicModel` field
- Campaign creation UI: dropdown with cost labels
- Update `music-generation.ts` type union if needed for `minimax-music-v26`

**Tests:** model selection honored, null → default, fallback on failure, UI renders selector

---

#### Story S1-07: Schema Migration, Tests, Typecheck, and PRD Update
**Files:** `prisma/schema.prisma`, new migration, `__tests__/sprint1-segmentation.test.ts` (new)  
**Work:**
- Add `motionLevel`, `dominantMode`, `transcriptWordsJson` to Asset
- Add `speechIntensityScore`, `motionLevel` to ClipScore
- Add `musicModel` to Campaign
- Run `prisma migrate dev --name add_smart_segmentation_fields`
- Update `.env.example` with new variables
- Consolidate all unit tests for new logic
- `npm run typecheck` clean
- Update this PRD with implementation log

## 10. Success Metrics

### 10.1 Quantitative Targets

| Metric | Before Sprint 1 | Target After Sprint 1 |
|--------|----------------|----------------------|
| Avg clips per uploaded video | 1.0 (full video = 1 clip) | ≥ 3.0 for videos >30s |
| Score variance across clips from same source video | Near 0 (all identical) | Standard deviation ≥ 15 points |
| Top clip score vs. source video score (ratio) | 1.0x (same) | ≥ 1.4x (best clip scores higher than whole) |
| SPEECH clips making highlight cut | ~5% (often eliminated) | ≥ 25% of high-intensity speech clips included |
| Avg frames extracted per 30s SPEECH clip | ~12 (fixed) | ≤ 30 (1 fps, adaptive) |
| Avg frames extracted per 15s ACTION clip | ~6 (fixed) | 45 (3 fps, better coverage) |
| Frames per Venice API call | 3 | 6 (doubled throughput) |
| Venice API calls per 15s ACTION clip | ~2 (6 frames ÷ 3) | 8 (45 frames ÷ 6) |
| Transcription accuracy (coach speech) | No diarization | Coach segments identified ≥ 80% accuracy |
| Vision LLM cost per event (avg) | Baseline | ≤ baseline + 25% (more frames per ACTION clip, fewer per SPEECH) |
| Music model default | Hardcoded elevenlabs ($1.25) | minimax-music-v26 (~$0.10) |

### 10.2 Qualitative Success Criteria

- A user uploading a 3-minute baseball at-bat video should see 4–8 child clips in the event view, with the clip containing the hit scoring notably higher than clips containing non-swings
- A user uploading a coach speech video should see individual sentence-level clips, with the most emotionally intense quotes scoring highest and coach-identified segments prioritized
- The final 60-second highlight reel produced after Sprint 1 should feel noticeably more curated — fewer dead moments, more peaks — compared to the current output
- Users should see a clear music model selector with cost labels when creating a campaign, and ElevenLabs should be clearly marked as premium

## 11. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| ffmpeg scene-filter produces too many boundary points for complex action videos | Medium | Medium | Phase 4 merge pass + MAX_CLIPS_PER_SOURCE cap handles this by design |
| Venice beta /audio/transcribe unavailable or returns unexpected schema | Medium | Low | Whisper fallback is battle-tested and always available; quality flag records which path was used |
| Diarization misidentifies speakers (coach vs. parent) | Medium | Low | Coach heuristic (directive words + utterance length) is conservative; misidentified segments get standard 1× weight — no worse than current behavior |
| STT word timestamps unavailable or inaccurate | Medium | Low | Speech segmentation gracefully falls back to motion-only boundaries; SPEECH mode requires VAD confirmation, not STT alone |
| I-frame snapping cannot find a keyframe within ±500ms | Low | Low | Fall back to exact timestamp with re-encode of just that keyframe if needed |
| Per-clip SCORE_CLIP jobs multiply LLM cost significantly | Medium | High | Frame cap (120 max) + dynamic density (1 fps SPEECH) keeps per-clip cost low; net cost increase estimated ≤25% despite more clips; batch size 6 reduces API calls |
| 120-frame cap produces high per-clip cost ($1.80) for 60s+ clips | Low | Medium | Only ACTION clips reach this cap; 2 fps for >30s keeps cost reasonable; budget enforcement unchanged |
| Long videos (>5 min) produce too many child clips overwhelming job queue | Low | Medium | MAX_CLIPS_PER_SOURCE=20 hard cap; additional merging to respect this limit |
| Sibling rollup race condition (two SCORE_CLIP jobs finish simultaneously) | Low | Low | Prisma upsert is atomic; "check if all siblings scored" query uses database-level count; worst case is a double-write of the same max value |
| Backward compatibility: old SOURCE_VIDEO Assets without children get scored as before | Low | Low | `score-clip` only skips SOURCE_VIDEO with `childAssets.length > 0`; existing videos without children continue to be scored as today |
| Campaigns without musicModel get elevenlabs-music from old behavior | Medium | High | `generate-music.ts` default changed to `minimax-music-v26`; old campaigns with null musicModel get new default — intentional cost reduction |
| Audio RMS windowing produces inaccurate results for compressed audio codecs | Low | Low | ffmpeg `-ss`/`-t` extracts exact PCM for the window; codec affects source but not RMS computation after decode |

---

## Implementation Log

*Entries will be appended here as each story is completed.*

---

*PRD v2.0 written 2026-05-24. Ready for implementation.*