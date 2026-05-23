"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface SuggestedChange {
  file: string;
  description: string;
  diff: string;
  confidence: number;
  rationale: string;
}

interface LatestAnalysis {
  id: string;
  generatedAt: string;
  recommendations: string;
  feedbackCount: number;
  appliedAt: string | null;
  suggestedChanges: SuggestedChange[];
}

interface HistoryReport {
  id: string;
  generatedAt: string;
  feedbackCount: number;
  appliedAt: string | null;
  suggestedChangesCount: number;
  hasRecommendations: boolean;
}

export default function AdminFeedbackReportsPage() {
  const [analysis, setAnalysis] = useState<LatestAnalysis | null>(null);
  const [history, setHistory] = useState<HistoryReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);

  useEffect(() => {
    fetchReports();
  }, []);

  async function fetchReports() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/feedback-report/analysis", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load reports");
      const data = await res.json();
      if (data.analysis) setAnalysis(data.analysis);
      if (data.history) setHistory(data.history);
    } catch {
      setError("Failed to load feedback reports");
    } finally {
      setLoading(false);
    }
  }

  async function runAnalysis() {
    setAnalyzing(true);
    setError("");
    try {
      const res = await fetch("/api/admin/feedback-report/analysis", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Analysis failed");
      const data = await res.json();
      if (data.analysis) {
        setAnalysis(data.analysis);
        // also refresh history
        await fetchReports();
      }
    } catch {
      setError("Failed to run analysis");
    } finally {
      setAnalyzing(false);
    }
  }

  async function copyDiff(change: SuggestedChange, reportId: string) {
    try {
      await navigator.clipboard.writeText(change.diff);
      setCopiedId(`${reportId}-${change.file}`);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      alert("Failed to copy to clipboard");
    }
  }

  async function markApplied(reportId: string, notes?: string) {
    setMarkingId(reportId);
    try {
      const res = await fetch(`/api/admin/feedback-report/${reportId}/applied`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes || "" }),
      });
      if (!res.ok) throw new Error("Failed to mark applied");
      await fetchReports();
    } catch {
      setError("Failed to mark report as applied");
    } finally {
      setMarkingId(null);
    }
  }

  const latestSuggested = analysis?.suggestedChanges || [];

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-500">Loading feedback reports...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-sm text-zinc-500 hover:text-zinc-900 mb-1 inline-block">
              &larr; Dashboard
            </Link>
            <h1 className="text-xl font-bold text-zinc-900">Feedback Reports &amp; Suggestions</h1>
            <p className="text-sm text-zinc-500">Flywheel insights and patch proposals</p>
          </div>
          <button
            onClick={runAnalysis}
            disabled={analyzing}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {analyzing ? "Analyzing..." : "Run Analysis Now"}
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-8">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
            {error}
          </div>
        )}

        {/* Latest Report Summary */}
        {analysis ? (
          <div className="bg-white rounded-lg border border-zinc-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">Latest Analysis</h2>
                <p className="text-sm text-zinc-500">
                  {new Date(analysis.generatedAt).toLocaleString()} · {analysis.feedbackCount} feedback records
                </p>
              </div>
              {analysis.appliedAt && (
                <span className="text-xs px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full">
                  Applied {new Date(analysis.appliedAt).toLocaleDateString()}
                </span>
              )}
            </div>

            {/* Recommendations */}
            <div className="bg-zinc-50 rounded-md p-4 text-sm text-zinc-700 whitespace-pre-wrap leading-relaxed mb-6">
              {analysis.recommendations || "No recommendations yet."}
            </div>

            {/* Structured Suggested Changes */}
            <div>
              <h3 className="text-sm font-semibold text-zinc-800 mb-3">
                Structured Patch Suggestions ({latestSuggested.length})
              </h3>
              {latestSuggested.length === 0 ? (
                <p className="text-sm text-zinc-500">No validated suggestions in this report.</p>
              ) : (
                <div className="space-y-4">
                  {latestSuggested.map((change, idx) => {
                    const key = `${analysis.id}-${idx}`;
                    const isCopied = copiedId === key;
                    const isMarking = markingId === analysis.id;
                    return (
                      <div key={idx} className="border border-zinc-200 rounded-lg p-4 bg-white">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <code className="text-xs bg-zinc-100 px-2 py-0.5 rounded font-mono text-zinc-700">
                                {change.file}
                              </code>
                              <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">
                                {(change.confidence * 100).toFixed(0)}% confidence
                              </span>
                            </div>
                            <p className="font-medium text-sm text-zinc-900 mb-1">{change.description}</p>
                            <p className="text-xs text-zinc-600 mb-3">{change.rationale}</p>

                            <details className="text-xs">
                              <summary className="cursor-pointer text-blue-600 hover:underline">View unified diff</summary>
                              <pre className="mt-2 p-3 bg-zinc-900 text-zinc-100 rounded text-[10px] overflow-x-auto font-mono whitespace-pre">
                                {change.diff}
                              </pre>
                            </details>
                          </div>

                          <div className="flex flex-col gap-2 shrink-0">
                            <button
                              onClick={() => copyDiff(change, analysis.id)}
                              className="px-3 py-1.5 text-xs border border-zinc-300 rounded hover:bg-zinc-50 transition"
                            >
                              {isCopied ? "✓ Copied" : "Copy Diff"}
                            </button>
                            {!analysis.appliedAt && (
                              <button
                                onClick={() => markApplied(analysis.id)}
                                disabled={isMarking}
                                className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 transition"
                              >
                                {isMarking ? "Marking..." : "Mark Applied"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-zinc-200 p-8 text-center text-zinc-500">
            No analysis reports yet. Click “Run Analysis Now” after collecting feedback.
          </div>
        )}

        {/* History + Simple Trend */}
        <div className="bg-white rounded-lg border border-zinc-200 p-6">
          <h3 className="text-sm font-semibold text-zinc-800 mb-4">Recent Reports ({history.length})</h3>

          {history.length > 0 ? (
            <div className="space-y-2">
              {history.map((r) => (
                <div key={r.id} className="flex items-center justify-between text-sm border-b border-zinc-100 pb-2 last:border-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-zinc-400 w-32">
                      {new Date(r.generatedAt).toLocaleDateString()}
                    </span>
                    <span className="text-zinc-600">
                      {r.feedbackCount} feedbacks
                    </span>
                    {r.suggestedChangesCount > 0 && (
                      <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                        {r.suggestedChangesCount} suggestions
                      </span>
                    )}
                  </div>
                  <div>
                    {r.appliedAt ? (
                      <span className="text-emerald-600 text-xs">Applied</span>
                    ) : (
                      <span className="text-amber-600 text-xs">Pending review</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No historical reports yet.</p>
          )}

          {/* Simple visual trend (feedback volume) */}
          {history.length > 1 && (
            <div className="mt-6">
              <p className="text-xs text-zinc-500 mb-2">Feedback volume trend (most recent first)</p>
              <div className="flex items-end gap-1 h-16">
                {history.slice(0, 8).reverse().map((r, i) => {
                  const max = Math.max(...history.map(h => h.feedbackCount));
                  const h = max > 0 ? Math.round((r.feedbackCount / max) * 100) : 0;
                  return (
                    <div key={i} className="flex-1 bg-blue-500/70 rounded-t" style={{ height: `${Math.max(h, 8)}%` }} />
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="text-xs text-zinc-400">
          Suggestions are AI-generated and require manual review before applying. Low-confidence items are still shown for transparency.
        </div>
      </main>
    </div>
  );
}
