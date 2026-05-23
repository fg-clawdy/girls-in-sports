// Weekly Critique Service for GIS
// Aggregates CompositionFeedback and generates LLM-powered critique reports

import { prisma } from "./prisma";
import type { CompositionFeedback, Prisma } from "@prisma/client";
import { type SuggestedChange, validateSuggestedChange, ALLOWED_FILES } from "./feedback-analysis";

interface WeeklyFeedbackAggregate {
  total: number;
  productionWorthyCount: number;
  avgRatings: Record<string, number>;
  issueCounts: Record<string, number>;
  likedMostTexts: string[];
  wouldChangeTexts: string[];
  freeformNotes: string[];
  scripts: unknown[];
}

/**
 * Aggregate all feedback from a given date range.
 */
export async function aggregateFeedback(
  startDate: Date,
  endDate: Date
): Promise<WeeklyFeedbackAggregate> {
  const feedbacks = await prisma.compositionFeedback.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const result: WeeklyFeedbackAggregate = {
    total: feedbacks.length,
    productionWorthyCount: 0,
    avgRatings: {},
    issueCounts: {},
    likedMostTexts: [],
    wouldChangeTexts: [],
    freeformNotes: [],
    scripts: [],
  };

  if (feedbacks.length === 0) return result;

  // Collect ratings
  const ratingSums: Record<string, number> = {};
  const ratingCounts: Record<string, number> = {};

  for (const fb of feedbacks) {
    if (fb.productionWorthy) result.productionWorthyCount++;

    if (fb.ratings && typeof fb.ratings === "object") {
      const ratings = fb.ratings as Record<string, number>;
      for (const [key, val] of Object.entries(ratings)) {
        if (typeof val === "number") {
          ratingSums[key] = (ratingSums[key] || 0) + val;
          ratingCounts[key] = (ratingCounts[key] || 0) + 1;
        }
      }
    }

    // Count issues — simple keyword extraction from freeformNotes
    if (fb.freeformNotes) {
      result.freeformNotes.push(fb.freeformNotes);
      const lower = fb.freeformNotes.toLowerCase();
      const issueKeywords = ["too long", "wrong music", "too short", "blurry", "text", "transition", "cut", "boring", "repetitive", "music", "speed", "zoom"];
      for (const kw of issueKeywords) {
        if (lower.includes(kw)) {
          result.issueCounts[kw] = (result.issueCounts[kw] || 0) + 1;
        }
      }
    }

    if (fb.likedMost) result.likedMostTexts.push(fb.likedMost);
    if (fb.wouldChange) result.wouldChangeTexts.push(fb.wouldChange);
    if (fb.generatedScript) result.scripts.push(fb.generatedScript);
  }

  // Compute averages
  for (const [key, sum] of Object.entries(ratingSums)) {
    const count = ratingCounts[key] || 1;
    result.avgRatings[key] = Math.round((sum / count) * 100) / 100;
  }

  // Sort issues by frequency
  result.issueCounts = Object.fromEntries(
    Object.entries(result.issueCounts).sort((a, b) => b[1] - a[1])
  );

  return result;
}

// ─── LLM Critique Generation ─────────────────────────────────────────────────

interface CritiqueConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

function getConfig(): CritiqueConfig {
  return {
    apiUrl: process.env.VENICE_API_URL || "https://api.venice.ai/api/v1",
    apiKey: process.env.VENICE_API_KEY || "",
    model: process.env.CRITIQUE_MODEL || process.env.VENICE_MODEL || "z-ai-glm-5-turbo",
  };
}

const CRITIQUE_SYSTEM_PROMPT = `You are an expert GIS tuning engineer for Girls In Sports (GIS), a youth sports camp brand.

Your task: Analyze a week's worth of composition feedback data and produce a strategic critique report.

Output MUST be valid JSON with no markdown, no explanations outside the JSON. Format:

{
  "critiqueText": "string (2-3 paragraphs of narrative analysis)",
  "topIssues": ["string", "string", ...],
  "topLiked": ["string", "string", ...],
  "topChanges": ["string", "string", ...],
  "actionItems": ["string", "string", ...],
  "suggestedChanges": [
    {
      "file": "src/lib/tier-formulas.ts",
      "description": "short summary",
      "diff": "--- a/...\n+++ b/...\n@@ ... @@\n",
      "confidence": 0.82,
      "rationale": "based on feedback data"
    }
  ]
}

Guidelines:
- critiqueText, topIssues, topLiked, topChanges, actionItems: as before.
- suggestedChanges: only for files in the allowlist (tier-formulas.ts, prompt-engineer.ts, beat-sync-service.ts, scene-detection-service.ts, vision.ts, music-generation.ts, scripts/analyze_beats.py). Produce minimal unified diffs (≤50 lines), confidence 0.0-1.0. Never touch unlisted files. Concrete, reviewable patches only.`;

interface LLMCritiqueResult {
  critiqueText: string;
  topIssues: string[];
  topLiked: string[];
  topChanges: string[];
  actionItems: string[];
  suggestedChanges: SuggestedChange[];
}

async function generateCritiqueWithLLM(
  aggregate: WeeklyFeedbackAggregate,
  config: CritiqueConfig
): Promise<LLMCritiqueResult> {
  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: CRITIQUE_SYSTEM_PROMPT },
      { role: "user", content: buildCritiquePrompt(aggregate) },
    ],
    max_tokens: 3000,
    temperature: 0.4,
  };

  const res = await fetch(`${config.apiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Critique LLM error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const rawContent: string = data.choices?.[0]?.message?.content || "";

  // Extract JSON
  let jsonStr = rawContent;
  const codeBlockMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  } else {
    const firstBrace = rawContent.indexOf("{");
    const lastBrace = rawContent.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = rawContent.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const base = {
      critiqueText: String(parsed.critiqueText || ""),
      topIssues: Array.isArray(parsed.topIssues) ? parsed.topIssues.map(String) : [],
      topLiked: Array.isArray(parsed.topLiked) ? parsed.topLiked.map(String) : [],
      topChanges: Array.isArray(parsed.topChanges) ? parsed.topChanges.map(String) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
      suggestedChanges: [] as SuggestedChange[],
    };
    const rawChanges: unknown[] = Array.isArray(parsed.suggestedChanges) ? parsed.suggestedChanges : [];
    for (const ch of rawChanges) {
      const v = validateSuggestedChange(ch);
      if (v.valid && v.change) base.suggestedChanges.push(v.change);
    }
    return base;
  } catch (parseErr) {
    console.error("Failed to parse critique LLM response:", rawContent.slice(0, 1000));
    throw new Error(`Invalid critique JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
  }
}

function buildCritiquePrompt(aggregate: WeeklyFeedbackAggregate): string {
  const lines: string[] = [];

  lines.push(`# Weekly Feedback Analysis`);
  lines.push(`Total feedback submissions: ${aggregate.total}`);
  lines.push(`Production-worthy rate: ${aggregate.total > 0 ? Math.round((aggregate.productionWorthyCount / aggregate.total) * 100) : 0}%`);

  lines.push(`\n## Average Ratings (1-5 scale)`);
  for (const [key, val] of Object.entries(aggregate.avgRatings)) {
    lines.push(`- ${key}: ${val}`);
  }

  lines.push(`\n## Issue Frequency`);
  for (const [issue, count] of Object.entries(aggregate.issueCounts)) {
    lines.push(`- "${issue}": ${count} mentions`);
  }

  lines.push(`\n## What Users Liked Most`);
  for (const text of aggregate.likedMostTexts.slice(0, 10)) {
    lines.push(`- "${text}"`);
  }

  lines.push(`\n## What Users Would Change`);
  for (const text of aggregate.wouldChangeTexts.slice(0, 10)) {
    lines.push(`- "${text}"`);
  }

  lines.push(`\n## Freeform Notes`);
  for (const text of aggregate.freeformNotes.slice(0, 5)) {
    lines.push(`- "${text}"`);
  }

  lines.push(`\nGenerate the critique report.`);
  return lines.join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface WeeklyCritiqueResult {
  id: string;
  weekStart: Date;
  weekEnd: Date;
  totalFeedback: number;
  avgProductionWorthy: number;
  avgRatings: Record<string, number>;
  topIssues: string[];
  topLiked: string[];
  topChanges: string[];
  critiqueText: string;
  actionItems: string[];
  suggestedChanges: SuggestedChange[];
  modelUsed: string;
  costDIEM: number;
}

/**
 * Generate a weekly critique report for the given week.
 * If no week is specified, analyzes the previous calendar week (Mon-Sun).
 */
export async function generateWeeklyCritique(
  weekStart?: Date
): Promise<WeeklyCritiqueResult> {
  const config = getConfig();

  // Default to previous week if not specified
  const now = new Date();
  const targetWeekStart = weekStart || getPreviousMonday(now);
  const targetWeekEnd = new Date(targetWeekStart);
  targetWeekEnd.setDate(targetWeekEnd.getDate() + 6);
  targetWeekEnd.setHours(23, 59, 59, 999);

  // Aggregate
  const aggregate = await aggregateFeedback(targetWeekStart, targetWeekEnd);

  if (aggregate.total === 0) {
    // No feedback this week — create empty report
    const empty = await prisma.weeklyCritique.create({
      data: {
        weekStart: targetWeekStart,
        weekEnd: targetWeekEnd,
        totalFeedback: 0,
        avgProductionWorthy: null,
        avgRatings: {},
        topIssues: [],
        topLiked: [],
        topChanges: [],
        critiqueText: "No feedback received this week.",
        actionItems: [],
        suggestedChanges: [],
        modelUsed: "none",
        costDIEM: 0,
      },
    });
    return {
      id: empty.id,
      weekStart: empty.weekStart,
      weekEnd: empty.weekEnd,
      totalFeedback: 0,
      avgProductionWorthy: 0,
      avgRatings: {},
      topIssues: [],
      topLiked: [],
      topChanges: [],
      critiqueText: empty.critiqueText,
      actionItems: [],
      suggestedChanges: [],
      modelUsed: "none",
      costDIEM: 0,
    };
  }

  // Generate LLM critique
  let llmResult: LLMCritiqueResult;
  let costDIEM = 0;

  if (config.apiKey) {
    try {
      llmResult = await generateCritiqueWithLLM(aggregate, config);
      costDIEM = 0.02; // rough heuristic for a single critique generation
    } catch (err) {
      console.error("LLM critique generation failed, using fallback:", err);
      llmResult = generateFallbackCritique(aggregate);
    }
  } else {
    llmResult = generateFallbackCritique(aggregate);
  }

  // Persist
  const avgProductionWorthy =
    aggregate.total > 0 ? aggregate.productionWorthyCount / aggregate.total : 0;

  const record = await prisma.weeklyCritique.create({
    data: {
      weekStart: targetWeekStart,
      weekEnd: targetWeekEnd,
      totalFeedback: aggregate.total,
      avgProductionWorthy,
      avgRatings: aggregate.avgRatings,
      topIssues: llmResult.topIssues.slice(0, 5),
      topLiked: llmResult.topLiked.slice(0, 5),
      topChanges: llmResult.topChanges.slice(0, 5),
      critiqueText: llmResult.critiqueText,
      actionItems: llmResult.actionItems.slice(0, 5),
      suggestedChanges: JSON.parse(JSON.stringify(llmResult.suggestedChanges || [])) as any,
      modelUsed: config.model,
      costDIEM,
    },
  });

  return {
    id: record.id,
    weekStart: record.weekStart,
    weekEnd: record.weekEnd,
    totalFeedback: record.totalFeedback,
    avgProductionWorthy: record.avgProductionWorthy || 0,
    avgRatings: (record.avgRatings as Record<string, number>) || {},
    topIssues: record.topIssues,
    topLiked: record.topLiked,
    topChanges: record.topChanges,
    critiqueText: record.critiqueText,
    actionItems: record.actionItems,
    suggestedChanges: ((record.suggestedChanges as unknown) as SuggestedChange[]) || [],
    modelUsed: record.modelUsed,
    costDIEM: record.costDIEM || 0,
  };
}

function generateFallbackCritique(aggregate: WeeklyFeedbackAggregate): LLMCritiqueResult {
  const worthyRate = aggregate.total > 0 ? Math.round((aggregate.productionWorthyCount / aggregate.total) * 100) : 0;

  const topIssues = Object.entries(aggregate.issueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([issue]) => issue);

  return {
    critiqueText: `This week, ${aggregate.total} compositions were reviewed with a ${worthyRate}% production-worthy rate. ` +
      `Top-rated dimensions: ${Object.entries(aggregate.avgRatings).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${v})`).join(", ")}. ` +
      `Most common concerns: ${topIssues.slice(0, 3).join(", ") || "none noted"}.`,
    topIssues: topIssues.length > 0 ? topIssues : ["No major issues flagged"],
    topLiked: aggregate.likedMostTexts.length > 0 ? ["Users appreciated the content selection"] : ["No positive feedback recorded"],
    topChanges: aggregate.wouldChangeTexts.length > 0 ? ["Users suggested timing and music adjustments"] : ["No change requests recorded"],
    actionItems: [
      "Review average ratings for dimensions scoring below 3.0",
      "Address most common issues in next week's pipeline updates",
      "Experiment with clip duration adjustments based on feedback",
    ],
    suggestedChanges: [],
  };
}

function getPreviousMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1; // Days since Monday
  d.setDate(d.getDate() - diff - 7); // Go back to previous Monday
  d.setHours(0, 0, 0, 0);
  return d;
}
