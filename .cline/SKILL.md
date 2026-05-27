---
name: girls-in-sports
description: "Highly disciplined implementation skill for the Girls In Sports (GIS) production readiness project. Strictly follows one-story-at-a-time, exhaustive exploration-first (search_files + read_file + list_code_definition_names on all relevant files before ANY edit), zero-new-comments, exact-pattern-reuse, and PRD-log-append rules derived from US-001 through US-015 implementation. Use this skill for every production readiness story, schema change, test addition, UI update, handler extension, or flywheel improvement. Trigger on any task referencing US-*, PRD-PROD-READINESS.md, CODE_ASSESSMENT.md, tier-formulas, handlers/*, scenes as child Assets, suggestedChanges, qualityFlags, beat-sync in render-final, requireAdmin, cost-estimator enforcement, or orphaned service cleanup. Always maintain the exact architecture: API routes enqueue only, work in src/lib/handlers/*.ts + services, persistent jobs via worker.ts, child Asset model for scenes with resolveSceneCut, structured pino logging, validated suggestedChanges with ALLOWED_FILES allowlist, Jest tests for every critical path."
---

# Girls In Sports Implementation Skill

This skill formalizes the rigorous patterns used to complete US-001 through US-015 in PRD-PROD-READINESS.md. It ensures the codebase remains consistent, testable, maintainable, and self-improving while delivering production readiness (security, cost governance, closed flywheel with structured patches, first-class child clip assets/scenes, professional render quality or honest warnings, error visibility, observability).

## Deployment Architecture

- **host01 (rpin03):** Raspberry Pi 4 Model B, 4 GB RAM, Ubuntu 22.04, NGINX reverse proxy
  - Buffers uploads to SSD before proxying to host02
  - 88 GB free disk, 3.3 GB free RAM, NO swap
  - NGINX config at: `docs/REMOTE-NGINX-CONFIG`
  - Upload paths use: `client_body_in_file_only on`, `proxy_request_buffering on`
- **host02 (app server):** Intel i7-12700K (VM), 3.4–8 GB RAM, Ubuntu 26.04
  - Next.js on port 3010, Worker on port 3011, PostgreSQL
  - 3.9 GB swap (already under pressure at 3.4 GB RAM — target upgrade to 8 GB)
  - Health endpoint: `GET http://host02:3011/health` returns memory/system stats

## Critical Constraints

1. **OOM is the #1 operational risk.** Every code change that touches file I/O, ffmpeg, or uploads must consider memory impact.
2. **ALL ffmpeg/ffprobe spawns must use `spawnLimitedFfmpeg()` / `spawnLimitedFfprobe()`** from `src/lib/ffmpeg-utils.ts`. Never spawn ffmpeg directly. These wrappers apply `OMP_NUM_THREADS=1`, `nice -n 10`, generous timeouts, and memory guards.
3. **Never use `readFileSync()` or `fs.readFileSync()` on files that could be larger than a few KB.** Use `createReadStream()` with `highWaterMark: 64 * 1024`.
4. **Upload memory zero-pressure:** Pass `File` objects directly into `FormData`, never `await file.arrayBuffer()`.
5. **Memory ceiling guard:** Before any ffmpeg spawn, the `spawnLimited*()` wrappers check `/proc/meminfo` MemAvailable. If < 512MB free, the spawn is rejected with an error and the job is requeued.
6. **Nice priority:** All ffmpeg/ffprobe runs at `nice -n 10` so the Next.js web server always gets CPU priority.
7. **Generous timeouts:** Scene detection 10min, audio extraction 5min, keyframe extraction 1min/frame, stream-copy cut 2min, proxy render 10min, final render 20min. All get `SIGTERM` on expiry.

## Core Principles (Never Violate)

1. **Exploration First (Phase 0)**: Before any write_to_file, replace_in_file, or schema change:
   - Use `search_files` with targeted regex for patterns (e.g. "requireAdmin", "child Asset", "suggestedChanges", "qualityFlags", "resolveSceneCut", "beatTimestampsJson", "computeTieredScore").
   - `read_file` on ALL relevant files: handlers (ingest-clip, score-clip, direct-script, generate-music, render-proxy, render-final, quality-tracking), UI pages (events/[id]/page, curate, admin/*, dashboard), schema.prisma, tests, services (tier-formulas, composer, prompt-engineer, beat-sync-service, feedback-analysis, weekly-critique-service, cost-estimator, logger, resolve-scene-cut), migration scripts, PRD-PROD-READINESS.md, CODE_ASSESSMENT.md.
   - `list_code_definition_names` on src/lib/, src/app/api/, __tests__/.
   - Understand current state, existing patterns, and how the new change fits (e.g. child CLIP vs legacy SceneSegment, legacy virtual scenes sharing immichAssetId).

2. **One-Story Discipline**: Implement **exactly one US story per invocation**. Do not proceed to next story until current one has:
   - All Acceptance Criteria satisfied (including "Typecheck passes", "Write Jest tests for happy-path + error paths", "Verify UI renders correctly...", migration script if needed).
   - `npm run typecheck` clean (ignore pre-existing pino module error until installed).
   - Relevant tests passing.
   - Detailed entry appended to **Implementation Log** section of PRD-PROD-READINESS.md.
   - task_progress updated and all subtasks marked complete.

3. **Zero New Comments Rule**: NEVER add `//` or `/* */` comments to any production .ts/.tsx/.js file. Keep source clean. Documentation lives only in PRD, README, test files, or inline via variable names and structure. Use only edit tools; zero comments added in all previous US implementations.

4. **Exact Pattern Reuse**:
   - **Job Pipeline**: API routes (`/api/*`) only validate, check budget/auth, enqueueJob. All work in `src/lib/handlers/*.ts` (ingest-clip.ts, score-clip.ts, direct-script.ts, generate-music.ts, render-proxy.ts, render-final.ts, quality-tracking.ts). Register new JobType in worker.ts.
   - **Auth/Security**: Every /api/admin/* route starts with `const adminCheck = await requireAdmin(request); if (adminCheck instanceof NextResponse) return adminCheck;`. Use X-Admin-Token header for scripts, httpOnly `gis-admin-session` cookie for UI (credentials: 'include'). No middleware for admin (Node runtime only). Audit log on every decision.
   - **Cost Governance**: Call `cost-estimator.checkAndReserveBudget(...)` before vision, STT, LLM, music, render, analysis. Hard stops with 402. Circuit breaker per event. Update Event.currentEstimatedCost. Use DEFAULT_EVENT_BUDGET_USD.
   - **Scenes/Child Assets**: Canonical model is child `Asset` with `type = 'CLIP'`, `parentAssetId`, `startTimeMs`, `endTimeMs`. Legacy SceneSegment converted via migration script (idempotent, re-runs safely). Use `resolveSceneCut(asset, scriptTimes)` in renders/composer for correct source + absolute timestamps. Update clips route, curate UI (SCENE labels, selectAll excludes full videos when scenes present), score-clip (windowed for legacy, direct for real children), CampaignClip.
   - **Flywheel**: Auto-trigger after threshold feedback (FEEDBACK_ANALYSIS_THRESHOLD). Critique services return `suggestedChanges[]` (validated against ALLOWED_FILES list: tier-formulas.ts, prompt-engineer.ts, beat-sync-service.ts, scene-detection-service.ts, vision.ts keywords, music-generation.ts prompts, analyze_beats.py). Unified diff format, ≤50 lines, confidence 0-1, validator rejects invalid. Store in reportJson.suggestedChanges. Dashboard shows confidence, Copy Diff (≥0.7), Mark Applied. Low confidence (<0.7) filtered/greyed.
   - **Render Quality**: No topazUpscale (removed per spike). Low-res (<720px height) shows "SD" badge in curate + sidecar note in Immich FINAL description. Beat-sync: post-GENERATE_MUSIC, analyzeBeats -> Campaign.beatTimestampsJson; render-final/proxy use getBeatAlignedDuration/snapToNearestBeat when present. Proxy and final aligned for consistency.
   - **Error/Quality**: qualityFlags Json on Job for partial failures (visionFailedBatches, visionUsedFallback, sttFailed). User-facing banners ("X clips failed vision – using fallbacks"). Circuit breakers from cost-estimator. Structured pino logger with {jobId, eventId, stage, durationMs, costEstimate, ...}.
   - **Observability**: /api/health, worker /health, structured logs replace console.* in critical paths.
   - **Tests**: Add specific __tests__/*.test.ts (clips-child-assets, score-clip-scenes, render-scene-cut, render-beat-sync, render-low-res-decision, score-clip-quality, us014-quality-tracking). Happy + error + legacy paths. Extend existing tests where possible.
   - **Migrations**: Idempotent scripts in scripts/ (e.g. migrate-legacy-scenes-to-child-assets.ts). Run with `npx tsx`. prisma db push + generate after schema changes. Mark deprecated models with comments.

5. **PRD Log Discipline**: After completing a story, append **exactly** in the established format to the **Implementation Log** section at the bottom of PRD-PROD-READINESS.md:
   ```
   **US-XXX: Title** — **COMPLETED** YYYY-MM-DD

   **Status:** passes: true

   **What was implemented:**
   - Bullet list of concrete changes (files edited, models added, helpers created, tests written, UI updates).

   **Reused / followed:**
   - Existing patterns (list specific files, girls-in-sports skill rules, previous US).
   - prd-completor: full exploration before first write, one story, ACs as spec, zero new comments, update PRD log exactly.

   **Notes / caveats:**
   - Runtime steps (prisma db push, run migration, npm install, manual browser verification).
   - Any limitations or follow-on work.

   **Next:** US-YYY (when re-invoked).
   ---
   ```
   Update the top summary if needed. Never remove previous logs.

6. **Tool & Progress Rules**:
   - Use `task_progress` in **every** tool call with comprehensive Markdown checklist. Update status accurately. Start with full list when beginning new story.
   - Prefer non-interactive CLI (execute_command with flags). Run `npm run typecheck`, relevant `npm test -- __tests__/xxx.test.ts`, `npx prisma generate`.
   - For UI verification: suggest `npm run dev` + manual check via attempt_completion command.
   - When complete (all ACs, tests, typecheck, PRD updated), use `attempt_completion` with short summary + command to review (e.g. `npm test` or open specific page).

7. **Tricky Situations**:
   - **Orphaned Services**: Audit with grep first (as in US-017). Delete if dead (quality-gate, pre-filter) with README note + schema cleanup.
   - **Conditional Stories** (e.g. US-011 after spike): Document spike decision clearly, follow "remove + honest warnings" path if no working upscale.
   - **Legacy Compatibility**: Support both real child CLIPs and legacy virtual scenes (shared immichAssetId + timing) via resolveSceneCut and score-clip windowing.
   - **Baseline**: Capture before any flywheel patches (US-018).
   - **pino**: Install via npm if missing; typecheck may warn until then — ignore for src/.

Follow this skill religiously. It is the living embodiment of how the GIS platform reached production readiness. Every change must preserve or enhance the flywheel, scene accuracy, cost control, security, observability, and test coverage.

When user invokes with a US story or "continue implementation", begin with full exploration, update task_progress, then implement precisely.