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

/**
 * Aggregate CampaignFeedback from the past 30 days and send to Venice
 * reasoning model for actionable recommendations.
 */
export async function runFeedbackAnalysis(): Promise<{
  id: string;
  recommendations: string;
  feedbackCount: number;
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

  const reportJson = JSON.parse(JSON.stringify(input));

  // Send to Venice reasoning model
  const recommendations = await getRecommendationsFromLLM(input);

  // Store in FeedbackAnalysisReport
  const report = await prisma.feedbackAnalysisReport.create({
    data: {
      reportJson,
      recommendations,
      feedbackCount: feedbacks.length,
    },
  });

  console.log(`[feedback-analysis] Generated report ${report.id} from ${feedbacks.length} feedback records`);

  return {
    id: report.id,
    recommendations,
    feedbackCount: feedbacks.length,
  };
}

async function getRecommendationsFromLLM(input: AnalysisInput): Promise<string> {
  if (!VENICE_API_KEY) {
    return "VENICE_API_KEY not configured. Recommendations unavailable.";
  }

  const systemPrompt = `You are a product analytics expert for a sports video marketing platform called Girls In Sports.
Analyze the provided feedback data and produce 3-5 specific, actionable recommendations.
Focus on:
1. Score weight adjustments (vision/audio/motion currently at 50/30/20)
2. Duration threshold changes for scene detection (currently 3-120s)
3. Keyword list gaps for speech-to-text scoring
4. Music generation prompt improvements

Be concise. Use bullet points. Each recommendation should be 1-2 sentences with specific numbers.`;

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

Provide actionable recommendations.`;

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
      max_tokens: 1200,
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
  return data.choices?.[0]?.message?.content?.trim() || "No recommendations generated.";
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
