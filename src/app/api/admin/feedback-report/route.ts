import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export async function GET(request: Request) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    // Past 30 days of feedback
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
      orderBy: { createdAt: "desc" },
    });

    const total = feedbacks.length;
    if (total === 0) {
      return NextResponse.json({
        period: { since: since.toISOString(), until: new Date().toISOString() },
        total: 0,
        aggregates: null,
        message: "No feedback in the past 30 days",
      });
    }

    // Aggregates
    const avgRating = feedbacks.reduce((sum, f) => sum + f.overallRating, 0) / total;
    const productionWorthyPct =
      (feedbacks.filter((f) => f.productionWorthy).length / total) * 100;

    // Most common wouldChange themes (simple keyword extraction)
    const wouldChangeTexts = feedbacks
      .map((f) => f.wouldChange)
      .filter(Boolean) as string[];
    const themes = extractThemes(wouldChangeTexts);

    // Clip sentiment distribution by clipType
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

    // Music satisfaction rate
    const musicResponses = feedbacks.filter((f) => f.musicSatisfied !== null);
    const musicSatisfiedPct =
      musicResponses.length > 0
        ? (musicResponses.filter((f) => f.musicSatisfied).length / musicResponses.length) * 100
        : null;

    const aggregates = {
      avgRating: Math.round(avgRating * 100) / 100,
      productionWorthyPct: Math.round(productionWorthyPct * 100) / 100,
      musicSatisfiedPct: musicSatisfiedPct ? Math.round(musicSatisfiedPct * 100) / 100 : null,
      totalFeedback: total,
      wouldChangeThemes: themes,
      sentimentByType,
      feedbacks: feedbacks.map((f) => ({
        id: f.id,
        campaignId: f.campaignId,
        overallRating: f.overallRating,
        productionWorthy: f.productionWorthy,
        wouldChange: f.wouldChange,
        musicSatisfied: f.musicSatisfied,
        createdAt: f.createdAt.toISOString(),
        eventSport: f.campaign?.event?.sport || null,
      })),
    };

    return NextResponse.json({
      period: { since: since.toISOString(), until: new Date().toISOString() },
      total,
      aggregates,
    });
  } catch (error) {
    console.error("GET /admin/feedback-report error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
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
