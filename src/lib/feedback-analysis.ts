import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const VENICE_API_URL = process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VENICE_API_KEY || "";

interface AnalysisInput {
  totalFeedback: number;
  avgRating: number;
  productionWorthyPct: number;
  musicSatisfiedPct: number | null;
  wouldChangeThemes: Array<{ theme: string; count: number }>;
  sentimentByType: Record<string, { positive: number; negative: number; total: number }>;
}

// Shared types and validator for US-005 structured patch suggestions (used by weekly-critique-service too)
export interface SuggestedChange {
  file: string;
  description: string;
  diff: string;
  confidence: number;
  rationale: string;
}

export const ALLOWED_FILES = [
  "src/lib/tier-formulas.ts",
  "src/lib/prompt-engineer.ts",
  "src/lib/beat-sync-service.ts",
  "src/lib/scene-detection-service.ts",
  "src/lib/vision.ts",
  "src/lib/music-generation.ts",
  "scripts/analyze_beats.py",
];

export function validateSuggestedChange(change: unknown): { valid: boolean; error?: string; change?: SuggestedChange } {
  if (!change || typeof change !== "object") return { valid: false, error: "not an object" };
  const c = change as Record<string, unknown>;
  if (typeof c.file !== "string" || !ALLOWED_FILES.includes(c.file)) {
    return { valid: false, error: `file not in allowlist: ${c.file}` };
  }
  if (typeof c.diff !== "string" || !c.diff.startsWith("--- a/") || !c.diff.includes("+++ b/")) {
    return { valid: false, error: "diff must be unified format starting with --- a/ and +++ b/" };
  }
  const lineCount = c.diff.split("\n").length;
  if (lineCount > 55) return { valid: false, error: "diff too large (>50 lines)" };
  const conf = typeof c.confidence === "number" ? c.confidence : parseFloat(String(c.confidence));
  if (isNaN(conf) || conf < 0 || conf > 1) return { valid: false, error: "confidence must be 0.0-1.0" };
  return {
    valid: true,
    change: {
      file: c.file,
      description: String(c.description || ""),
      diff: c.diff,
      confidence: conf,
      rationale: String(c.rationale || ""),
    },
  };
}

/**
 * Aggregate CampaignFeedback from the past 30 days and send to Venice
 * reasoning model for actionable recommendations.
 */
export async function runFeedbackAnalysis(): Promise<{
  id: string;
  recommendations: string;
  feedbackCount: number;
  suggestedChanges: SuggestedChange[];
}> {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const feedbacks = await prisma.campaignFeedback.findMany({
    where: { createdAt: { gte: since } },
    include: {
      campaign: {
        include: {
          event: { select: { sport: true } },
          campaignClips: {
            include: { asset: { include: { clipScore: true } } },
          },
        },
      },
    },
  });

  if (feedbacks.length < 5) {
    throw new Error(`Insufficient feedback: ${feedbacks.length} records (minimum 5 required)`);
  }

  const avgRating = feedbacks.reduce((sum, f) => sum + f.overallRating, 0) / feedbacks.length;
  const productionWorthyPct =
    (feedbacks.filter((f) => f.productionWorthy).length / feedbacks.length) * 100;

  const musicResponses = feedbacks.filter((f) => f.musicSatisfied !== null);
  const musicSatisfiedPct =
    musicResponses.length > 0
      ? (musicResponses.filter((f) => f.musicSatisfied).length / musicResponses.length) * 100
      : null;

  // Extract themes from wouldChange
  const wouldChangeTexts = feedbacks
    .map((f) => f.wouldChange)
    .filter(Boolean) as string[];
  const themes = extractThemes(wouldChangeTexts);

  // Sentiment by clip type
  const sentimentByType: Record<string, { positive: number; negative: number; total: number }> = {};
  for (const fb of feedbacks) {
    const sentiments = (fb.clipSentiments as any[]) || [];
    for (const s of sentiments) {
      const asset = fb.campaign?.campaignClips?.find(
        (cc) => cc.assetId === s.assetId
      )?.asset;
      const clipType = asset?.clipScore?.clipType || "UNKNOWN";
      if (!sentimentByType[clipType]) {
        sentimentByType[clipType] = { positive: 0, negative: 0, total: 0 };
      }
      sentimentByType[clipType].total++;
      if (["like", "thumbs-up", "positive"].includes(s.sentiment)) {
        sentimentByType[clipType].positive++;
      } else if (["dislike", "too-long", "too-short", "thumbs-down"].includes(s.sentiment)) {
        sentimentByType[clipType].negative++;
      }
    }
  }

  const input: AnalysisInput = {
    totalFeedback: feedbacks.length,
    avgRating: Math.round(avgRating * 100) / 100,
    productionWorthyPct: Math.round(productionWorthyPct * 100) / 100,
    musicSatisfiedPct: musicSatisfiedPct ? Math.round(musicSatisfiedPct * 100) / 100 : null,
    wouldChangeThemes: themes,
    sentimentByType,
  };

  // Send to Venice reasoning model (now returns both text + structured suggestions per US-005)
  const llmOutput = await getRecommendationsFromLLM(input);

  const reportJson = {
    ...JSON.parse(JSON.stringify(input)),
    suggestedChanges: llmOutput.suggestedChanges,
  };

  // Store in FeedbackAnalysisReport (suggestions live inside reportJson)
  const report = await prisma.feedbackAnalysisReport.create({
    data: {
      reportJson,
      recommendations: llmOutput.recommendations,
      feedbackCount: feedbacks.length,
    },
  });

  console.log(`[feedback-analysis] Generated report ${report.id} from ${feedbacks.length} feedback records`);

  return {
    id: report.id,
    recommendations: llmOutput.recommendations,
    feedbackCount: feedbacks.length,
    suggestedChanges: llmOutput.suggestedChanges,
  };
}

async function getRecommendationsFromLLM(input: AnalysisInput): Promise<{
  recommendations: string;
  suggestedChanges: SuggestedChange[];
}> {
  if (!VENICE_API_KEY) {
    return { recommendations: "VENICE_API_KEY not configured. Recommendations unavailable.", suggestedChanges: [] };
  }

  const systemPrompt = `You are an expert GIS tuning engineer for Girls In Sports.
You must output ONLY valid JSON (no markdown, no prose outside the JSON) with this exact shape:
{
  "recommendations": "3-5 concise bullet-point recommendations (1-2 sentences each, with specific numbers)",
  "suggestedChanges": [
    {
      "file": "src/lib/tier-formulas.ts",
      "description": "short human-readable summary",
      "diff": "--- a/src/lib/tier-formulas.ts\n+++ b/src/lib/tier-formulas.ts\n@@ -42,7 +42,7 @@\n-  old line\n+  new line\n",
      "confidence": 0.82,
      "rationale": "why this change based on the feedback data"
    }
  ]
}
Rules:
- Only target the allowlisted files: src/lib/tier-formulas.ts, src/lib/prompt-engineer.ts, src/lib/beat-sync-service.ts, src/lib/scene-detection-service.ts, src/lib/vision.ts, src/lib/music-generation.ts, scripts/analyze_beats.py
- diff MUST be minimal unified diff format, <= 50 lines total changed, start with --- a/ and +++ b/, at most one @@ hunk.
- confidence 0.0-1.0 (suppress <0.7 in UI later).
- Never invent new files or touch unlisted code. Produce concrete, reviewable patches only.`;

  const userPrompt = `Feedback data (past 30 days):
- Total feedback: ${input.totalFeedback}
- Average rating: ${input.avgRating} / 5
- Production-worthy: ${input.productionWorthyPct.toFixed(1)}%
- Music satisfaction: ${input.musicSatisfiedPct !== null ? `${input.musicSatisfiedPct.toFixed(1)}%` : "N/A"}

Top "would change" themes: ${input.wouldChangeThemes.map((t) => `${t.theme} (${t.count})`).join(", ")}

Sentiment by clip type:
${Object.entries(input.sentimentByType)
  .map(([type, stats]) => `- ${type}: ${stats.positive}/${stats.total} positive (${((stats.positive / stats.total) * 100).toFixed(0)}%)`)
  .join("\n")}

Return the JSON object now.`;

  const res = await fetch(`${VENICE_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VENICE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen-qwq-32b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1400,
      temperature: 0.3,
      reasoning_effort: "medium",
      strip_reasoning_response: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM analysis failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "{}";

  // Robust JSON extraction (handles ```json blocks or bare object)
  let jsonStr = raw;
  const codeBlock = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlock) jsonStr = codeBlock[1];
  else {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first !== -1 && last !== -1) jsonStr = raw.slice(first, last + 1);
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const recs = String(parsed.recommendations || "No recommendations generated.");
    const rawChanges: unknown[] = Array.isArray(parsed.suggestedChanges) ? parsed.suggestedChanges : [];
    const validated: SuggestedChange[] = [];
    for (const ch of rawChanges) {
      const v = validateSuggestedChange(ch);
      if (v.valid && v.change) validated.push(v.change);
    }
    return { recommendations: recs, suggestedChanges: validated };
  } catch (e) {
    console.error("[feedback-analysis] Failed to parse LLM JSON for suggestions:", raw.slice(0, 800));
    return { recommendations: raw, suggestedChanges: [] };
  }
}

function extractThemes(texts: string[]): Array<{ theme: string; count: number }> {
  const stopWords = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "is", "was", "be", "been", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "i", "we", "it", "this", "that", "more", "less", "too", "very", "so", "just", "get", "got", "need", "want", "like", "dont", "doesnt", "didnt"]);
  const themeCounts = new Map<string, number>();

  for (const text of texts) {
    const words = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    for (const word of words) {
      themeCounts.set(word, (themeCounts.get(word) || 0) + 1);
    }
  }

  return Array.from(themeCounts.entries())
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}
