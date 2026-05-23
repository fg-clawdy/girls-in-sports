"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface FeedbackReport {
  period: { since: string; until: string };
  total: number;
  aggregates: {
    avgRating: number;
    productionWorthyPct: number;
    musicSatisfiedPct: number | null;
    totalFeedback: number;
    wouldChangeThemes: Array<{ theme: string; count: number }>;
    sentimentByType: Record<string, { positive: number; negative: number; total: number }>;
    feedbacks: Array<{
      id: string;
      campaignId: string;
      overallRating: number;
      productionWorthy: boolean;
      wouldChange: string | null;
      musicSatisfied: boolean | null;
      createdAt: string;
      eventSport: string | null;
    }>;
  } | null;
  message?: string;
}

interface AnalysisReport {
  id: string;
  generatedAt: string;
  recommendations: string;
  feedbackCount: number;
  appliedAt: string | null;
}

export default function AdminFeedbackPage() {
  const [report, setReport] = useState<FeedbackReport | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchReport();
    fetchLatestAnalysis();
  }, []);

  async function fetchReport() {
    try {
      const res = await fetch("/api/admin/feedback-report", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load report");
      const data = await res.json();
      setReport(data);
    } catch {
      setError("Failed to load feedback report");
    } finally {
      setLoading(false);
    }
  }

  async function fetchLatestAnalysis() {
    try {
      const res = await fetch("/api/admin/feedback-report/analysis", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data.analysis) setAnalysis(data.analysis);
      }
    } catch {
      // ignore
    }
  }

  async function runAnalysis() {
    setAnalyzing(true);
    try {
      const res = await fetch("/api/admin/feedback-report/analysis", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Analysis failed");
      const data = await res.json();
      if (data.analysis) setAnalysis(data.analysis);
    } catch {
      setError("Failed to run analysis");
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-500">Loading feedback data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  const agg = report?.aggregates;

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-sm text-zinc-500 hover:text-zinc-900 mb-1 inline-block">
              &larr; Dashboard
            </Link>
            <h1 className="text-xl font-bold text-zinc-900">Feedback Analytics</h1>
            <p className="text-sm text-zinc-500">
              {report?.period ? `${new Date(report.period.since).toLocaleDateString()} – ${new Date(report.period.until).toLocaleDateString()}` : ""}
            </p>
          </div>
          <button
            onClick={runAnalysis}
            disabled={analyzing || !agg}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {analyzing ? "Analyzing..." : "Run AI Analysis"}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {!agg || report?.total === 0 ? (
          <div className="bg-white rounded-lg border border-zinc-200 p-12 text-center">
            <p className="text-zinc-500">No feedback in the past 30 days.</p>
            <p className="text-sm text-zinc-400 mt-1">
              Feedback appears here after campaigns are delivered and rated.
            </p>
          </div>
        ) : (
          <>
            {/* Top metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard label="Avg Rating" value={`${agg.avgRating} / 5`} />
              <MetricCard
                label="Production Ready"
                value={`${agg.productionWorthyPct.toFixed(0)}%`}
                color={agg.productionWorthyPct > 70 ? "text-emerald-600" : "text-amber-600"}
              />
              <MetricCard
                label="Music Fit"
                value={agg.musicSatisfiedPct !== null ? `${agg.musicSatisfiedPct.toFixed(0)}%` : "—"}
              />
              <MetricCard label="Total Feedback" value={String(agg.totalFeedback)} />
            </div>

            {/* Would Change themes */}
            {agg.wouldChangeThemes.length > 0 && (
              <div className="bg-white rounded-lg border border-zinc-200 p-5">
                <h3 className="text-sm font-semibold text-zinc-800 mb-3">Top Themes in "Would Change"</h3>
                <div className="flex flex-wrap gap-2">
                  {agg.wouldChangeThemes.map((t) => (
                    <span
                      key={t.theme}
                      className="px-3 py-1 rounded-full text-xs font-medium bg-zinc-100 text-zinc-700"
                    >
                      {t.theme} ({t.count})
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Sentiment by clip type */}
            {Object.keys(agg.sentimentByType).length > 0 && (
              <div className="bg-white rounded-lg border border-zinc-200 p-5">
                <h3 className="text-sm font-semibold text-zinc-800 mb-3">Sentiment by Clip Type</h3>
                <div className="space-y-2">
                  {Object.entries(agg.sentimentByType).map(([type, stats]) => {
                    const positivePct = stats.total > 0 ? (stats.positive / stats.total) * 100 : 0;
                    return (
                      <div key={type} className="flex items-center gap-3">
                        <span className="w-20 text-xs font-medium text-zinc-600">{type}</span>
                        <div className="flex-1 h-4 bg-zinc-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-400 rounded-full"
                            style={{ width: `${positivePct}%` }}
                          />
                        </div>
                        <span className="text-xs text-zinc-500 w-12 text-right">
                          {stats.positive}/{stats.total}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Latest AI Analysis */}
            {analysis && (
              <div className="bg-white rounded-lg border border-zinc-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-zinc-800">Latest AI Recommendations</h3>
                  <span className="text-xs text-zinc-400">
                    {new Date(analysis.generatedAt).toLocaleDateString()} · {analysis.feedbackCount} feedbacks
                  </span>
                </div>
                <div className="bg-zinc-50 rounded-md p-4 text-sm text-zinc-700 whitespace-pre-wrap leading-relaxed">
                  {analysis.recommendations}
                </div>
                {analysis.appliedAt && (
                  <p className="text-xs text-emerald-600 mt-2">
                    Applied on {new Date(analysis.appliedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
            )}

            {/* Recent feedback table */}
            <div className="bg-white rounded-lg border border-zinc-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-100">
                <h3 className="text-sm font-semibold text-zinc-800">Recent Feedback</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-zinc-50">
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Rating</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Ready?</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Music</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Would Change</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Sport</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {agg.feedbacks.slice(0, 20).map((fb) => (
                      <tr key={fb.id} className="hover:bg-zinc-50">
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700">
                            {fb.overallRating}/5
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {fb.productionWorthy ? (
                            <span className="text-emerald-600 text-xs">Yes</span>
                          ) : (
                            <span className="text-red-500 text-xs">No</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-zinc-500">
                          {fb.musicSatisfied === null ? "—" : fb.musicSatisfied ? "👍" : "👎"}
                        </td>
                        <td className="px-4 py-2 text-xs text-zinc-600 max-w-[300px] truncate">
                          {fb.wouldChange || "—"}
                        </td>
                        <td className="px-4 py-2 text-xs text-zinc-500">{fb.eventSport || "—"}</td>
                        <td className="px-4 py-2 text-xs text-zinc-400">
                          {new Date(fb.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function MetricCard({
  label,
  value,
  color = "text-zinc-900",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-zinc-200 p-4">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
