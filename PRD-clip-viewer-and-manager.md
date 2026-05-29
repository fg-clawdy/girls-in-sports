# PRD: Clip Viewer & Manager

## Context

Clawdy wants to review scored clips by actually watching them and understanding why each scored the way it did. The Memorial Day event has duplicate clips from multiple ingest attempts that need cleanup.

**Core philosophy:** All clips are always visible. `Accepted` state controls campaign inclusion only. Truly poor clips are permanently removed via a `Remove` action. No hidden/ignored clips.

---

## User Stories

### US-001: Watch Scored Clips
**As a user, I want to click on a clip thumbnail and watch the video, so I can judge quality myself.**

- Add click handler to clip cards that opens a modal with an HTML5 `<video>` player
- Video plays the clip using the **parent source video** + `startTimeMs`/`endTimeMs` offsets
- Modal includes clip metadata (score breakdown, tags, transcript, score explanation if available)
- Close on backdrop click or ✕ button; Escape key closes

**Technical Note on Video Playback:**
- Child CLIP assets don't have their own video file. The modal fetches the **parent Asset's** `immichAssetId` and plays that source video.
- On modal open: `video.currentTime = clip.startTimeMs / 1000`, then `video.play()`
- On `timeupdate`: if `video.currentTime >= clip.endTimeMs / 1000`, `video.pause()`
- If the clip has no `parentAssetId` (it's a scored source video), play the full video

**Acceptance Criteria:**
- Clicking any clip thumbnail opens the video player modal
- Video auto-plays (desktop) or shows ready-to-play (mobile, due to browser policy)
- Modal shows: composite score, moment/production breakdown, clip type, duration, resolution
- Modal shows transcript excerpt if available
- Modal shows `scoreExplanation` if available (see US-002)
- Tags are listed in the modal
- `Accept` / `Reject` / `Must Include` buttons work from the modal (same as card buttons)
- `Set as thumbnail` button works from the modal
- `Remove clip` button opens confirmation dialog; on confirm, hard-deletes clip via existing `DELETE /api/events/{eventId}/assets/{assetId}`
- Keyboard: Escape closes modal, Space toggles play/pause when modal is open
- Modal is responsive: full-width on mobile, max-w-4xl on desktop

---

### US-002: Score Explanation
**As a user, I want a natural language explanation of why a clip scored the way it did, so I can understand and trust the scoring.**

Store a `scoreExplanation` field on `ClipScore` (TEXT, nullable). Populate it during the scoring pipeline by calling an LLM with the clip's analysis data.

**Cost Note:** ~0.3 DIEM per clip. For a 200-clip event, that's ~60 DIEM. The LLM call must not fail the scoring job if it errors.

**Prompt pattern:**
```
Based on this clip's analysis:
- Vision Score: {visionScore}/100
- Audio Score: {audioScore}/100  
- Motion Score: {motionScore}/100
- Has Faces: {hasFaces}
- Has Coach Speech: {hasCoachSpeech}
- Has Action Keyword: {hasActionKeyword}
- Has Crowd Roar: {hasCrowdRoar}
- Transcript: {transcriptExcerpt}

Explain in 1-2 sentences why this clip scored {compositeScore}/100 and what its strengths/weaknesses are.
```

**Acceptance Criteria:**
- `ClipScore.scoreExplanation` field added to schema
- Migration generated and applied
- `score-clip.ts` handler calls LLM to generate explanation with 10s AbortController timeout
- Fallback: on any error, store `null`; do NOT fail the scoring job
- Existing scored clips have `scoreExplanation = null` (no backfill — only new clips get explanations)
- Clip viewer modal displays the explanation below the score breakdown
- If `scoreExplanation` is null, show nothing (no "No explanation available" placeholder)

---

### US-003: Duplicate & Overlapping Segment Detection
**As a user, I want to clean up duplicate clips (Memorial Day event) and be warned about overlapping segments in the future.**

**Two distinct cases:**

1. **Exact Duplicates** — Same `parentAssetId` + same `startTimeMs`/`endTimeMs` (±1s tolerance). Caused by re-running ingest on the same footage. These are auto-cleaned: highest-scored clip kept, rest deleted.

2. **Overlapping Segments** — Same `parentAssetId` with >30% time overlap but different boundaries (e.g., a 5s at-bat vs a 10s clip containing the same at-bat plus runner to first). These are NOT duplicates — they are different editorial choices. They get flagged in the UI as "Overlapping Segments" for human decision.

**Duplicate Detection Algorithm:**
```typescript
// src/lib/clip-duplicate-detector.ts
interface DuplicateGroup {
  type: "EXACT_DUPLICATE" | "OVERLAPPING_SEGMENT";
  parentAssetId: string;
  clips: Array<{ id: string; startTimeMs: number; endTimeMs: number; score: number }>;
  keepId?: string; // highest-scored for EXACT_DUPLICATE
}

function findDuplicateClips(clips: ClipData[]): DuplicateGroup[] {
  // Group by parentAssetId
  // Within each group, check pairwise:
  //   overlap = intersection(startMs, endMs) / union(startMs, endMs)
  //   exact: |startA - startB| <= 1000ms AND |endA - endB| <= 1000ms
  //   overlapping: overlap > 0.3 but NOT exact
  // Transcript similarity: Levenshtein on transcriptExcerpt > 80% (optional signal)
}
```

**Ingest-Time Prevention (Moving Forward):**
Before creating a child CLIP Asset in `analyzeAndSegment`, check if an identical or near-identical clip already exists for that parent:
```typescript
const existing = await prisma.asset.findFirst({
  where: {
    parentAssetId: sourceAssetId,
    type: "CLIP",
    startTimeMs: { gte: candidateStart - 1000, lte: candidateStart + 1000 },
    endTimeMs: { gte: candidateEnd - 1000, lte: candidateEnd + 1000 },
  },
});
if (existing) skip creation; // don't create duplicates
```

**Acceptance Criteria:**
- `POST /api/events/[eventId]/clips/find-duplicates` endpoint returns `{ exactDuplicates: DuplicateGroup[], overlappingSegments: DuplicateGroup[] }`
- A **"Find Duplicates"** button in the curate section header opens a modal
- Exact duplicates modal: shows groups as rows, auto-selects highest-scored to keep, pre-checks rest for delete. "Delete Selected" button runs batch delete via existing `DELETE /api/events/{eventId}/assets/{assetId}`.
- Overlapping segments modal: shows groups as rows with side-by-side thumbnails, scores, and duration. No auto-action. Purely informational — user decides which to accept/reject for campaigns.
- After deletion, clip count updates in UI
- Ingest-time prevention: `analyzeAndSegment` skips creating clips that already exist within ±1s tolerance

---

### US-004: Remove Clips
**As a user, I want to permanently remove poor-quality clips to keep my workspace clean.**

- **Remove**: Hard delete from DB (Asset + ClipScore via cascade)
- **NOT** "ignore" — all clips are always visible. Remove is for clips that are truly unwanted.
- A clip rejected for one campaign may still be useful for another campaign later. Only remove clips that are objectively bad (blur, wrong orientation, no usable content, etc.)

**Acceptance Criteria:**
- Each clip card gets a **"Remove"** button (trash icon, small, in the action row)
- Clip viewer modal also gets a **"Remove"** button
- Clicking Remove opens a confirmation dialog: "Remove this clip? This cannot be undone."
- On confirm, calls existing `DELETE /api/events/{eventId}/assets/{assetId}`
- Removed clips disappear from the grid immediately
- Campaign references: `CampaignClip` has `onDelete: Cascade`, so deleting an asset removes it from any campaigns

---

## Technical Notes

### Video Playback Details
- For CLIP-type assets: fetch parent's `immichAssetId` via Prisma relation
- `<video>` src: `/api/immich/assets/{parentImmichAssetId}`
- `onLoadedMetadata`: `video.currentTime = startTimeMs / 1000`
- `ontimeupdate`: if `currentTime >= endTimeMs / 1000`, `video.pause()`
- Show buffering spinner while video loads
- If Immich asset returns 404: show error message "Source video unavailable"

### Error Handling
- Video 404: Show inline error, don't crash modal
- LLM timeout for scoreExplanation: store null, log warning
- Duplicate detection API failure: show toast, don't block UI

### Mobile Behavior
- Modal is full-screen on viewports < 640px
- Video controls are native (touch-friendly)
- No auto-play on mobile (browser policy)

---

## File Changes

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `scoreExplanation String?` to ClipScore |
| `src/lib/clip-duplicate-detector.ts` | New — duplicate/overlap detection logic |
| `src/app/api/events/[eventId]/clips/find-duplicates/route.ts` | New — duplicate detection endpoint |
| `src/app/events/[id]/page.tsx` | Add clip viewer modal, Remove button, duplicate detection UI |
| `src/lib/scene-detection-service.ts` | Add ingest-time duplicate prevention in `analyzeAndSegment` |
| `src/lib/handlers/score-clip.ts` | Call LLM to generate scoreExplanation |
| `src/app/api/events/[id]/clips/route.ts` | Select `scoreExplanation` in query |

---

## Priority Order
1. **US-001** (Watch clips) — Foundation, enables all review
2. **US-004** (Remove clips) — Immediate cleanup capability
3. **US-003** (Find Duplicates) — Bulk cleanup for Memorial Day
4. **US-002** (Score explanation) — Nice to have, can defer

---

## Status
- [x] US-001: Watch Scored Clips ✓ (commit fee7679)
- [ ] US-002: Score Explanation
- [x] US-003: Duplicate & Overlapping Segment Detection ✓ (commit 1748b01)
- [ ] US-004: Remove Clips
