**Full Codebase Review – Girls In Sports (as of 2026-05-21)**

**Executive Summary**

The project has a sophisticated architecture and several recent high-quality improvements (transparent tiered scoring, new agentic director prompts, scene detection service, beat-sync foundation, and a solid job pipeline). However, there is a massive disconnect between the ambitious claims in the two PRDs (especially PRD-gis-ai-refinement.json) and what is actually wired into the main user journey.

Most of the "passes: false" items in the AI-refinement PRD are still false. The closed data flywheel (the entire point of the refinement project) is almost entirely absent from the normal flow. Several "professional output" and "production-ready" features are either placeholders or broken. Security, cost control, and operational readiness are at hobby-project levels.

This is a high-potential system that is currently held together by manual admin intervention and best-effort fallbacks. It is not yet safe or reliable for real customer events at scale.

**Prioritized List of Large Gaps (PRD-Relevant)**

1. **Data Flywheel Is Not Closed (Highest-Impact Gap)**
   - PRD repeatedly claims: "feedback from actual usage automatically improves future generations" (US-010, US-011, US-012, US-013, etc.).
   - Reality: CompositionFeedbackPanel exists and is shown in results/preview/download pages. Ratings are stored. However:
     - runFeedbackAnalysis is only called from admin scripts or /api/admin/feedback-report/analysis.
     - No code path updates scoring formulas, tier thresholds, prompt templates, or model selection based on real user feedback.
     - Weekly critique and pre-filter are admin-only.
   - Consequence: Every event starts from the same static heuristics. The system does not get smarter with usage.

2. **Scene-Aware Curation & Vision Analysis Missing (US-002, US-003, US-005, US-007, US-012)**
   - Scene detection service exists and populates SceneSegment.
   - But: curate page (src/app/events/[id]/page.tsx) and clips API only show whole assets/clips. No per-scene breakdown or "expand video into scenes" UI.
   - Vision analysis in score-clip runs on whole-clip keyframes, not scene-level.
   - Retroactive-scenes endpoint exists but is admin-only and does not feed back into scoring or curate.
   - Large UX and accuracy gap: users cannot curate the actual best moments inside long videos.

3. **Beat-Synchronized Editing (US-009) Is Not Implemented in Production Path**
   - beat-sync-service + Python librosa script works and is called in media-engine for music BPM detection.
   - However, render-final.ts cutSegment (lines 346-359) uses raw script startTime/endTime with pure -ss/-to ffmpeg copy — zero beat snapping.
   - render-proxy has some alignment helpers but is legacy.
   - Verdict: "Beat-sync editing" claim is false in the final deliverable.

4. **Topaz / Venice Video Enhancement Is a Non-Functional Placeholder**
   - render-final.ts topazUpscale (lines 284-344) explicitly labeled "placeholder".
   - Calls non-existent ${VENICE_URL}/video/enhance, then polls a job that never materializes.
   - Always falls back to original for sub-720p clips (the exact case it was meant to fix).
   - Serious quality risk for mobile-phone footage that dominates real events.

5. **A/B Testing & Automatic Variant Generation (US-011) – Not Implemented**
   - No code for generating multiple composition variants, running A/B tests, or cost-gated model selection.
   - Prompt-engineer and composer support user intent, but no experimentation layer.

6. **Thumbnail Auto-Select (US-008) Is Crude**
   - Best compositeScore asset's Immich ID is written to Event.description.
   - No face-quality, action-peak, or brand-composition logic. No user override UI.
   - Minor compared to above but still a visible polish gap.

**Serious Issues (Reliability, Security, Cost, Quality)**

1. **Admin Endpoints Are Completely Unprotected**
   - /api/admin/pre-filter, /retroactive-scenes, /weekly-critique, /feedback-report/analysis have zero authentication or role checks.
   - middleware.ts only does crude rate limiting; lib/auth.ts only checks "someone logged in".
   - Any logged-in user (or attacker with a stolen token) can run expensive retroactive scene jobs or trigger feedback analysis across all events.

2. **No Meaningful Cost Control or Rate Limiting on Expensive Paths**
   - In-memory token-bucket (60/min default, 10/min for upload) resets on every restart.
   - No per-event budget, no global daily cap, no circuit breakers on vision/STT/music/composition calls.
   - A single large event with hundreds of clips can easily burn hundreds of dollars in Venice vision + STT + LLM calls with no safeguard.
   - cost-estimator.ts exists but is never consulted at runtime.

3. **Zero Automated Test Coverage**
   - No *.test.*, *.spec.*, or __tests__ directories with real tests.
   - jest.config is present but unused for coverage.
   - The new tier scoring, scene pipeline, and entire handler chain have no regression protection.

4. **Error Handling Is "Silent Fallback or Job Retry" Only**
   - Vision, STT, LLM parse, ffmpeg, and Immich failures mostly result in console.warn + degraded output or failed jobs with no user-visible explanation.
   - No dead-letter queue, no circuit breakers, no per-stage retry with exponential backoff inside handlers (only the outer job worker retries 3 times).
   - A single bad vision batch or STT failure can silently tank an entire event's scores.

5. **Production Readiness / Observability Gaps**
   - No health checks, metrics, structured logging, or alerting.
   - Worker (scripts/worker.ts) is a simple polling loop with no visibility into queue depth or failure rates.
   - Manual intervention is required to diagnose or recover most failures.

6. **Architectural Smells & Duplication**
   - Multiple advanced services (quality-gate, pre-filter, feedback-analysis, weekly-critique) are either dead code or admin-only while the main flow uses a completely separate path.
   - Scoring logic lives in score-clip handler + clips route + tier-formulas with no single source of truth for "why a clip is good."
   - Scene detection runs but is never consumed by the systems that would benefit most (scoring, curate, vision).

**High-Impact Improvement Opportunities (Ranked by Leverage)**

1. **Close the Data Flywheel (Biggest ROI)**
   - Wire runFeedbackAnalysis to run automatically (or on schedule) after any CompositionFeedback is created.
   - Feed aggregated insights back into tier thresholds, prompt templates, or a learned "good clip" model.
   - Make the system demonstrably better after 5–10 real events.

2. **Make SceneSegments First-Class in Curation & Scoring**
   - Expose per-scene breakdown in the curate UI (expand long videos).
   - Re-run vision analysis at scene level for better momentScore accuracy.
   - Use scenes as the atomic unit for composition scripts.

3. **Fix or Remove the Topaz Placeholder**
   - Either implement a real working upscale path (or switch to a reliable service) or remove the dead code so it doesn't give false hope.
   - At minimum, surface a clear "low-resolution source – quality will be limited" warning to users.

4. **Implement Real Beat-Sync Cutting in render-final**
   - Pass beatTimestamps into the final cut decisions.
   - Snap clip boundaries and music onsets to nearest beats (the infrastructure mostly exists).

5. **Harden Security & Cost Control (Non-Negotiable for Production)**
   - Add proper role-based access (admin vs regular user) and protect all /api/admin/* routes.
   - Add real rate limiting + per-event cost budgets with hard stops and alerts.
   - Log and audit all expensive operations and admin actions.

6. **Add Minimal but Real Test Coverage + Better Observability**
   - At least unit tests for tier-formulas, computeTieredScore, and the critical scoring path.
   - Add structured logging and a simple health endpoint.
   - Consider lightweight integration tests for the job pipeline.

**Verdict on Current State vs PRD Claims**

- Transparent tier scoring: **Done well** (recent improvement).
- Agentic user-intent composition prompts: **Good foundation**.
- Scene detection infrastructure: **Exists but unused**.
- Closed data flywheel, scene-aware curation, beat-sync editing, professional upscale, A/B testing, production-grade reliability/security/cost control: **Largely missing or broken**.

The system can produce nice outputs today for small, manually supervised events. It is not yet the autonomous, self-improving, production-grade platform described in the PRDs.

**Recommendation**

Prioritize in this order:
1. Security & cost control (stop the bleeding).
2. Close the feedback flywheel (unlock the core value proposition).
3. Make scenes real in the UI and scoring (biggest accuracy/UX leap).
4. Fix or kill the Topaz and beat-sync placeholders.
5. Add basic tests and observability.

Once these are addressed, the existing architecture (job pipeline, composer, prompt engineer, new tier formulas) will be able to deliver on the original vision.

This review focused exclusively on large gaps and serious issues as requested. Smaller polish items, style inconsistencies, and low-severity bugs were deliberately ignored.