# PRD-PROD-READINESS: Girls In Sports – Production-Ready AI Video Composition Platform

**Project:** Girls In Sports (GIS) AI Composition & Feedback Platform – Production Readiness & Closed Data Flywheel  
**Branch Name:** `dev/prod-readiness-gis`  
**Description:** Transform the current promising prototype into a secure, cost-controlled, observable, self-improving production system by closing the data flywheel (with structured patch suggestions), elevating SceneSegments to first-class citizens, delivering working professional render quality (Topaz + beat-sync), hardening security & governance, and adding foundational reliability — all while preserving the successful proxy-then-final + human review gate design.  

**Date:** 2026-05-22  
**Version:** 1.0 (Initial Production Readiness Release)  
**Status:** Ready for Development Handover  
**Derived From:** Full codebase review (CODE_ASSESSMENT.md), PRD-gis-ai-refinement.json, current implementation state (feedback-analysis, weekly-critique-service, CompositionFeedbackPanel, render-final, scene services, tier-formulas, auth, worker, etc.), and explicit scope decisions (include Topaz/beat-sync as required; flywheel Option B: auto-trigger + dashboard + structured suggested changes/diffs).  

---

## 1. Executive Summary & Problem Statement

The GIS platform has strong architectural foundations (job pipeline, media-engine, proxy vs. final renders, transparent tiered scoring with momentScore/productionScore/clipType, agentic user-intent director prompts in prompt-engineer + composer). Recent work on tier-formulas and scoring is solid.

However, the ambitious vision in the original PRDs — a self-improving system where real usage data automatically makes future compositions better — is not yet delivered. The core promise remains unfulfilled:

- Feedback is collected (rich CompositionFeedback + CampaignFeedback via user-facing panels) but analysis/critique is manual/admin-only and never feeds back into production rules or prompts.
- Scene detection infrastructure exists but is bypassed in the main curation/scoring/composition flow.
- Professional-quality claims (beat-synchronized editing, Topaz/Venice upscale for mobile footage) are non-functional placeholders.
- Security (unprotected admin endpoints), cost governance (no real limits), reliability (zero tests, fragile error handling, no observability), and operational maturity are at experimental/prototype level.

**Consequence:** The system can produce good results for small, closely supervised events, but it is not autonomous, reliable, or safe at scale. Every new event starts from static rules. A single large event can generate uncontrolled Venice spend. The data flywheel — the central strategic lever — is open.

This PRD defines the **minimal set of work** required to declare the platform "Production Ready" for real customer events, directly addressing the 5 large gaps, 6 serious issues, and 6 high-impact improvements from the full codebase review (with the A/B auto-variant plan already superseded by the proxy + human review gate).

**Business Goal:** After this release, GIS can run real events with confidence: costs are governed, security is production-grade, the system measurably improves after 5–10 events via the closed flywheel (with developer-friendly structured suggestions), scenes are usable in curation, and final renders meet professional quality standards (or honestly surface limitations).

---

## 2. Target Users & Personas

- **Primary:** GIS staff curators / compositors (internal team uploading event footage, curating clips/scenes, directing compositions via natural language, reviewing proxy renders, giving rich multi-dimensional feedback, and exporting final campaigns).
- **Secondary:** GIS administrators / ops (monitoring reports, reviewing LLM critiques + suggested patches, applying improvements, managing cost budgets, handling failures).
- **Tertiary (future):** External customers/self-serve users (once platform is hardened and flywheel is proven).

Roughly 5–15 concurrent internal users at launch; events of 10–200+ clips.

---

## 3. Core Features & Scope

### In Scope for v1 Production Readiness (must be complete before "ready for real events")

- Security & cost governance (non-negotiable foundation).
- Closed data flywheel v1 with **Option B** (auto/scheduled trigger, admin dashboard, **structured suggested changes/patch proposals** that devs can directly apply).
- SceneSegments elevated to first-class citizens (UI curation, scoring, composition scripts).
- Working (or cleanly removed with honest warnings) Topaz/Venice upscale path in final render.
- Real beat-synchronized cutting in `render-final.ts` using existing beat-sync-service.
- Foundational reliability (minimum tests on critical paths, structured logging, health checks, improved error handling/recovery).
- Integration of existing cost-estimator, pre-filter, quality-gate, and weekly-critique services into main flows where valuable.
- All original PRD stories that align with the above and are not yet "passes: true" (scenes, feedback models, etc.), updated for current reality.

### Explicitly Out of Scope for this Release (deferred or already superseded)

- Old automatic A/B variant generation (superseded by proxy + human review gate — confirmed).
- Full lightweight ML ranking model training (flywheel will produce the data; actual model training is follow-on).
- Self-serve external customer portal / billing.
- Mobile app or non-web clients.
- Advanced analytics beyond the admin feedback dashboard.
- Retroactive processing of all historical events (only new data + on-demand for key stories).
- Perfect 100% test coverage or full CI/CD pipeline (minimum viable for critical paths + regression protection on scoring/flywheel).

---

## 4. Non-Functional Requirements (NFRs)

- **Security:** Proper role-based access control (or at minimum strong admin token + per-route guards). All `/api/admin/*` routes protected. No reliance on in-memory rate limiting alone. Audit logging for expensive operations. Secrets via env only.
- **Cost Control & Rate Limiting:** Real per-event budgets, global daily caps, circuit breakers on vision/STT/music/LLM calls. `cost-estimator.ts` consulted at composition planning time. Hard stops + notifications before spend exceeds thresholds. In-memory token bucket replaced by persistent mechanism.
- **Reliability & Observability:** Structured logging (pino or equivalent) with request IDs. Health endpoint (`/api/health`). Per-stage error surfacing to users (not silent console.warn). Dead-letter / retry with visibility in worker. Minimum 3 retries with exponential backoff + clear failure reasons.
- **Performance:** Proxy renders remain fast (< 2 min for typical event). Final renders respect user expectations. Analysis jobs run off critical path (nightly or threshold-triggered).
- **Data & Privacy:** Feedback data (including full scripts/intent) stored with clear retention policy. No PII leakage in logs or LLM prompts.
- **Maintainability:** All new code type-safe (TypeScript strict). New admin dashboard follows existing UI patterns (Tailwind + existing components). Dead/orphaned services (quality-gate, pre-filter when not used) are either integrated or clearly documented as admin-only.
- **Accessibility & UX:** All new UI (dashboard, scene browser) keyboard-navigable and responsive. Existing 9:16 mobile-first output preserved.
- **Testing:** Jest unit tests + integration tests for tier-formulas, scoring, feedback analysis/critique, render cut logic, auth guards, cost estimator. All critical handlers have happy-path + error-path coverage. `Typecheck passes` on every story.
- **Cost of Analysis:** LLM critique calls (Venice) are rate-limited and logged; flywheel must not itself become an uncontrolled cost center.

---

## 5. Success Metrics & KPIs (Measurable Definition of Done)

- **Flywheel Impact (Core Value):** After 10 real events with ≥5 feedback records each, average `productionWorthy` rate increases by ≥15% relative to baseline (or average dimension rating across the 9 sliders increases by ≥0.4 points). First LLM critique report produced automatically within 24h of 5th feedback record. ≥80% of reports contain at least one actionable numeric recommendation that a developer applies within 7 days.
- **Security & Cost:** Zero unauthorized access to admin endpoints in production. 100% of compositions go through cost estimator and respect per-event budget (no single event exceeds $X without explicit override). Daily/weekly spend alerts fire reliably.
- **Scene Adoption:** In events with detected scenes, ≥60% of compositions use at least one scene segment (measured via composition script). Scene-aware re-scoring improves momentScore accuracy (human validation on sample).
- **Render Quality:** 100% of final renders either use working Topaz upscale (when source <720p) or surface clear "source resolution limited – no upscale applied" warning to user. Beat-sync alignment applied to ≥90% of music-backed final cuts (measurable via cut timestamps vs. beat grid).
- **Reliability:** <5% of jobs fail silently (all failures have user-visible explanation + retry path). Worker has health metrics. Critical path (ingest → score → curate → compose → render) has regression tests that pass in CI.
- **Operational:** Admin dashboard loads latest report in <3s. Feedback analysis completes in <5 min for 30-day window. All expensive operations (vision, music gen, analysis) are logged with cost estimates.
- **Time-to-Value:** A new GIS staff member can upload an event, curate scenes, direct a composition, review proxy, give feedback, and see the feedback appear in the admin dashboard within one session.

---

## 6. Prioritized User Stories & Acceptance Criteria

Stories are ordered by implementation dependency (infrastructure/security first, then highest-impact flywheel, then scenes, then quality fixes, then reliability polish). Each story is a coherent, shippable unit. All start with `passes: false`.

**Priority scale:** 1 = must be done before any real customer event (foundation), 2 = core value delivery (flywheel), 3 = major UX/accuracy leap (scenes), 4 = professional output claims (Topaz/beat), 5 = reliability & ops.

### Security, Cost Governance & Reliability Foundation (Priority 1)

**US-001: Harden Authentication & Protect All Admin Endpoints**  
As a GIS administrator, I want all `/api/admin/*` routes (pre-filter, retroactive-scenes, weekly-critique, feedback-report/analysis) to require explicit, auditable admin authentication so that only authorized personnel can trigger expensive operations or view cross-event analysis.  
**Acceptance Criteria:**
- Replace weak token check (`isAdminAuth` using `ADMIN_SECRET` or `"gis-local-dev"`) with proper middleware guard or role check (e.g. JWT with `role: "admin"` or strong rotating admin token + IP allowlist in prod).
- Every admin route returns 401/403 with clear message on failure; no bypass via URL param alone.
- Audit log entry created for every successful admin action (who, what, when, cost estimate).
- Existing normal user login (`/api/auth/login`) remains unchanged and insufficient for admin routes.
- Middleware rate limiting upgraded to persistent (Redis or DB-backed) per-user/per-IP bucket.
- Verify UI renders correctly in browser at expected admin routes (no broken access).
- Typecheck passes.

**US-002: Implement Real Cost Governance & Budget Enforcement**  
As a GIS administrator, I want per-event cost budgets, global daily caps, and circuit breakers so that no single event can generate uncontrolled Venice spend and the team receives proactive alerts.  
**Acceptance Criteria:**
- `cost-estimator.ts` is consulted before every composition execution (in `/api/composition/execute` and composer planning).
- Event record gains `costBudgetUSD` (nullable, defaults to org default) and `currentEstimatedCost`.
- Hard stop: if projected cost > budget, composition is blocked with clear message + "request override" flow.
- Circuit breakers: consecutive vision/STT/music/LLM failures or cost spikes pause the stage for the event with notification.
- Daily/weekly aggregate spend tracked in DB; alerts (email/push) when thresholds crossed.
- Admin dashboard shows current spend vs. budget per event.
- All cost-impacting operations (vision rank, music generate, analysis LLM calls) are logged with estimated USD.
- Typecheck passes.

**US-003: Add Structured Logging, Health Endpoint, and Basic Observability**  
As an operator, I want structured logs, a `/api/health` endpoint, and visibility into worker queue health so that problems can be diagnosed without SSH or manual log grepping.  
**Acceptance Criteria:**
- All services use a structured logger (pino or equivalent) with `requestId`, `eventId`, `stage`, `costEstimate`, `duration`.
- New route `GET /api/health` returns `{ status: "ok", checks: { db, immich, venice, worker }, version, uptime }`.
- Worker (`src/scripts/worker.ts` / job-worker) emits metrics (queue depth, active jobs, failure rate) on a schedule or via endpoint.
- Error boundaries in handlers surface user-friendly messages (e.g. "Vision analysis failed for 3 clips – using fallback scores") instead of silent degradation.
- No more `console.warn` as primary error path for production-impacting failures.
- Typecheck passes.

### Closed Data Flywheel – Option B (Priority 2 – Highest Strategic Lever)

**US-004: Automatically Trigger Feedback Analysis on New CompositionFeedback or CampaignFeedback**  
As a GIS curator, when I submit feedback on a composition or final campaign, I want the system to automatically (or on a short schedule) run the appropriate critique service so that insights are generated without manual admin intervention.  
**Acceptance Criteria:**
- After successful `POST /api/feedback/composition`, if total CompositionFeedback for the event (or rolling 30-day window) meets configurable threshold (e.g. 3), enqueue a `run-weekly-critique` job via existing worker.
- Similarly, after `POST /api/campaigns/[id]/feedback`, enqueue `run-feedback-analysis` job.
- Jobs run via the existing `src/scripts/worker.ts` infrastructure (new job types `feedback-analysis` and `weekly-critique`).
- Analysis completes within 30 minutes of trigger (or next scheduled nightly run if load high).
- Duplicate runs prevented (idempotency via last-run timestamp or lock).
- Failures are retried 3x then dead-lettered with clear notification to admin.
- Typecheck passes.

**US-005: Extend Critique Services to Produce Structured Suggested Changes / Patch Proposals (Option B)**  
As a developer reviewing a feedback report, I want the LLM analysis to output not only human-readable recommendations but also machine-readable structured suggestions (target file, line range or semantic location, old/new text or diff) so I can directly apply or copy the improvement.  
**Acceptance Criteria:**
- Update `getRecommendationsFromLLM` (and equivalent in weekly-critique-service) to request a second structured output block in JSON: `suggestedChanges: Array<{ file: string; description: string; diff: string; confidence: number; rationale: string }>` or equivalent safe format.
- Parser validates that suggested diffs are minimal, target only known production files (tier-formulas.ts, prompt templates under lib/, scene thresholds, music prompt builders, STT keyword lists, etc.).
- Suggestions are stored alongside the text recommendations in the `FeedbackAnalysisReport` (new JSON column or related table).
- System prompt updated to emphasize "produce concrete, minimal, reviewable patches with exact numbers for score weights, thresholds, etc."
- Manual review step still required — no auto-apply to production code.
- Typecheck passes.

**US-006: Build Admin Feedback Reports Dashboard (View + Apply Suggestions)**  
As a GIS administrator, I want a clean, read-only (with copy/apply helpers) dashboard at `/admin/feedback-reports` showing the latest analysis report, historical trend, concrete recommendations, and one-click copy or "mark as applied" for suggested patches so that turning insights into code changes is fast and auditable.  
**Acceptance Criteria:**
- New route `src/app/admin/feedback-reports/page.tsx` (protected by US-001).
- Dashboard fetches latest + historical `FeedbackAnalysisReport` + `CompositionFeedback` aggregates via new or existing admin API.
- Displays: total feedback count, avg productionWorthy %, trend chart (simple Recharts or existing charting), top themes, per-dimension averages, full LLM text recommendations, and structured `suggestedChanges` list.
- Each suggestion has "Copy Diff" button and "Mark as Reviewed/Applied" (updates `appliedAt` + notes on the report).
- "Run Analysis Now" manual trigger button (still respects auth).
- Page loads in <3s; responsive; follows existing Tailwind design system.
- Verify UI renders correctly in browser at expected route `/admin/feedback-reports`.
- Typecheck passes.

**US-007: Persist & Expose Feedback Analysis Reports via API + Mark Applied**  
As a developer or admin, I want the full report (stats + text + structured suggestions) stored and queryable with `appliedAt` tracking so the flywheel state is auditable and the next analysis run can reference prior improvements.  
**Acceptance Criteria:**
- Prisma schema already supports `FeedbackAnalysisReport` (reportJson, recommendations, feedbackCount, appliedAt); extend if needed for structured suggestions.
- `GET /api/admin/feedback-report/analysis` (and new weekly-critique equivalent) returns full report including suggestions.
- `PATCH /api/admin/feedback-report/[id]/applied` marks a report (or individual suggestion) as applied with optional notes.
- Historical reports are retained for at least 90 days.
- Typecheck passes.

### Elevate SceneSegments to First-Class Citizens (Priority 3)

**US-008: Expose Scene Segments in Event Curation UI & Asset Grid**  
As a GIS curator, when I open an event with detected scenes, I want to see an "Expand to scenes" view or toggle in the asset grid and curate page so I can select precise peak moments instead of whole long videos.  
**Acceptance Criteria:**
- `GET /api/events/[id]/clips` (and the curate page `src/app/events/[id]/page.tsx`) returns both full assets and their `SceneSegment` children (with `isScene: true`, parent linkage).
- UI shows expandable rows or a "Scenes" tab/panel per video asset; selecting a scene adds only the segment (not the parent).
- "Select All" respects US-005 logic from original PRD (excludes full videos that have scenes).
- Scene thumbnails or keyframe previews are shown (reuse existing thumbnail logic or generate lightweight).
- Verify UI renders correctly in browser at expected route `/events/[id]`.
- Typecheck passes.

**US-009: Run Scene-Aware Vision Re-Scoring & Update Clip/Scene Scores**  
As a GIS curator, I want vision analysis and the new tier scoring to run (or be augmented) at the scene level so that `momentScore` and `productionScore` reflect the actual peak content inside long videos.  
**Acceptance Criteria:**
- Extend `score-clip.ts` (or add scene-specific path) to accept `SceneSegment` records; run keyframe extraction + vision rank on the best frame(s) inside each scene.
- Store scene-level scores (or link `ClipScore` to `SceneSegment`).
- Re-score existing scenes via the retroactive admin route (already exists) or new batch job.
- Composition scripts can now reference scene `id`s or `startTime`/`endTime` from segments.
- Typecheck passes.

**US-010: Support Scene Segments in Composition Scripts & Final Render**  
As a GIS curator, when I direct a composition that selects scenes, I want the generated script and final render to use the precise `startTime`/`endTime` from the SceneSegment so that cuts are accurate to the detected moment.  
**Acceptance Criteria:**
- `composer.ts` / prompt-engineer templates understand and prefer `SceneSegment` records when available.
- Output `CollageScript` / `VideoScript` entries can contain `sceneId` or direct `startTime`/`duration` from the segment.
- `render-final.ts` (and proxy) correctly use the scene-bounded timestamps for ffmpeg cuts.
- No regression for legacy full-clip selections.
- Typecheck passes.

### Professional Output Quality – Topaz & Beat-Sync (Priority 4 – Required for v1)

**US-011: Implement Working Topaz / Venice Video Upscale or Clean Removal + Honest Warnings**  
As a GIS curator uploading mobile-phone footage, I want the final render to either deliver a genuine quality upscale for sub-720p sources or clearly warn me that "source resolution is low – final quality will be limited" so there are no false promises.  
**Acceptance Criteria:**
- Remove or replace the placeholder `topazUpscale` function in `src/lib/handlers/render-final.ts`.
- If a real Venice `/video/enhance` (or equivalent) endpoint exists and works: integrate it with job polling, cost tracking, and graceful fallback.
- If no working upscale path: delete dead code, surface a persistent warning badge on the event/campaign UI when any source clip < 720p vertical, and document the limitation in the README and user-facing help.
- Final output metadata or sidecar notes the effective resolution and whether enhancement was applied.
- Typecheck passes.

**US-012: Activate Real Beat-Synchronized Cutting in render-final**  
As a GIS curator adding music, I want the final rendered video to have visual cuts snapped to the nearest musical beat (using the existing `beatTimestamps` from `beat-sync-service`) so that the "beat-sync editing" professional-quality claim is true for delivered output.  
**Acceptance Criteria:**
- In `render-final.ts` `cutSegment` (and equivalent proxy path), after determining raw `startTime`/`duration` from the script, call `snapToNearestBeat` / `getBeatAlignedDuration` from `beat-sync-service` when music BPM data exists for the event.
- The adjustment is logged and visible in the generated script metadata or render log.
- Proxy render already has the helpers; ensure final render matches or exceeds that quality.
- No regression for music-less renders.
- Typecheck passes.

### Foundational Reliability & Polish (Priority 5)

**US-013: Minimum Test Coverage on Tier Scoring, Feedback Analysis, Critical Handlers & Render Logic**  
As a developer, I want Jest tests for the new tier-formulas, `computeTieredScore`, feedback-analysis + weekly-critique services, cost-estimator, and the cut logic in render-final/proxy so that future changes do not silently regress production quality or the flywheel.  
**Acceptance Criteria:**
- New `__tests__/` files or additions to existing test structure covering:
  - `tier-formulas.ts` (all tier boundaries, event.qualityTier adjustments, moment vs. production score).
  - `score-clip.ts` happy path + error paths.
  - `feedback-analysis.ts` and `weekly-critique-service.ts` (mocked LLM, theme extraction, report creation).
  - Cost estimator and budget enforcement logic.
  - `render-final.ts` cut decisions (including new beat-alignment).
- All tests pass in CI (`npm test`).
- Coverage threshold (e.g. 70% on the above modules) enforced or documented.
- Typecheck passes.

**US-014: Improve Error Handling, Circuit Breakers, and User-Facing Failure Messages Across Pipeline**  
As a curator, when vision, STT, music generation, or an LLM call fails for part of an event, I want clear, actionable messages and automatic fallback/degraded paths instead of silent bad output or mysterious job failures.  
**Acceptance Criteria:**
- Every stage in the job handlers (`ingest-clip`, `score-clip`, `compose`, `render-*`) wraps external calls (Venice, Immich, ffmpeg, sharp) in try/catch that records the exact failure, marks partial success, and surfaces a `qualityFlags` or `jobError` record.
- User sees "3 clips failed vision analysis – using motion heuristics only" style messages on the event page.
- Circuit breaker pattern (simple in-memory or Redis) pauses repeated failing stages for an event.
- Dead-letter queue or "Retry with fallback" button for failed jobs.
- Typecheck passes.

**US-015: Thumbnail Auto-Select Improvements (Nice-to-Have but Included for Completeness)**  
As a GIS curator, I want the event thumbnail to be the best action/face/composition frame from the highest-scoring scene or clip (not just the single highest compositeScore asset) with a manual override option.  
**Acceptance Criteria:**
- Extend thumbnail selection logic (currently writes Immich ID to `Event.description`) to consider scene-level scores and simple face/action heuristics.
- New field or UI on event settings for manual thumbnail choice.
- Verify UI renders correctly in browser at expected event routes.
- Typecheck passes.

---

## 7. Implementation Order / Roadmap (Recommended Phases)

**Phase 1 – Stop the Bleeding (Security + Cost + Reliability) – US-001, US-002, US-003, US-013 (partial), US-014**  
Foundation that makes every subsequent story safe to run on real money and real events.

**Phase 2 – Close the Flywheel (Highest Strategic Value) – US-004, US-005, US-006, US-007**  
Delivers the core self-improvement promise with Option B structured suggestions. This is the biggest lever for long-term quality.

**Phase 3 – Make Scenes Real – US-008, US-009, US-010**  
Biggest accuracy and UX improvement; unlocks better moment detection and curation.

**Phase 4 – Deliver Professional Render Quality Claims – US-011, US-012**  
Removes false promises; either makes upscale/beat-sync work or is honest about limitations.

**Phase 5 – Polish & Ops – US-013 (remaining), US-015, documentation, migration scripts, monitoring dashboards**  
Ensures the platform is maintainable and the flywheel can run continuously.

Dependencies are explicit in story notes (e.g., scenes before scene-aware scoring).

---

## 8. Risks & Mitigations

- **Risk:** LLM-generated "suggested changes" could propose unsafe or incorrect edits.  
  **Mitigation:** Structured output is always human-reviewed; diffs are minimal and target only known files; confidence scores shown; no auto-apply.
- **Risk:** Automatic analysis jobs increase Venice spend.  
  **Mitigation:** US-002 cost governance applies to analysis calls; threshold triggers + nightly batching; explicit budgets.
- **Risk:** Scene detection + re-scoring adds significant compute time/cost on large events.  
  **Mitigation:** Async, off critical path; admin can disable per-event; cost estimator covers it.
- **Risk:** Integrating beat-sync into final render changes cut timing in ways users dislike.  
  **Mitigation:** Proxy already demonstrates the behavior; user can still adjust in the review/feedback flow; the flywheel will learn preferred vs. beat-aligned cuts.
- **Risk:** Scope creep on "professional quality".  
  **Mitigation:** Strict "working path or honest warning + removal of dead code" definition in US-011/US-012.

---

## 9. Traceability to CODE_ASSESSMENT Gaps & Issues

- **Data Flywheel Not Closed (Highest-Impact Gap):** US-004, US-005, US-006, US-007 (directly implements Option B automation + dashboard + patch suggestions).
- **SceneSegments Detected but Not Used in Main Flow:** US-008, US-009, US-010.
- **Beat-Synchronized Editing Not Active in Production Render:** US-012.
- **Topaz / Venice Upscale Non-Working Placeholder:** US-011.
- **Thumbnail Auto-Select Minimal:** US-015.
- **Admin Endpoints Unprotected:** US-001.
- **No Effective Cost Control:** US-002.
- **Zero Automated Test Coverage:** US-013.
- **Error Handling Fragile and Silent:** US-014.
- **Operational / Observability Gaps:** US-003.
- **Architectural Duplication & Dead Services:** Addressed by integrating or clearly documenting services during the above stories; flywheel work makes weekly-critique and feedback-analysis first-class.

All original PRD stories around scenes, feedback models, and continuous improvement that were "passes: false" are now covered or superseded by the above with updated, realistic ACs.

---

## 10. Definition of Done for the Release

- All stories above have `passes: true` (tests, typecheck, manual verification on real event data).
- A real 20–50 clip event can be uploaded, scenes detected and curated, composition directed with user intent, proxy reviewed with per-clip thumbs, feedback submitted, analysis auto-triggered, report appears in dashboard with at least one structured suggested patch, developer applies a patch, and the next composition for a similar event shows measurable improvement.
- Security audit (internal) passes on admin routes and cost paths.
- Cost of a typical event is predictable and under budget.
- No dead-code placeholders remain in the render path that claim capabilities that do not exist.

---

**Ready for implementation.**  
This document, together with the existing `CODE_ASSESSMENT.md`, `PRD-gis-ai-refinement.json`, the current schema, and the reviewed source files, provides a complete, unambiguous handover to the development team.

---

*End of PRD-PROD-READINESS.md*