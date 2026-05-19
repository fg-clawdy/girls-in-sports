"use client";

import { useState } from "react";

interface CompositionFeedbackProps {
  compositionId: string;
  script?: any;
  userIntent?: string;
  musicPrompt?: string;
  musicModel?: string;
  selectedAssetIds?: string[];
  outputDuration?: number;
  costDIEM?: number;
  onSubmitted?: () => void;
}

const RATING_DIMENSIONS = [
  { key: "assetSelection", label: "Asset Selection" },
  { key: "cutTiming", label: "Cut Timing" },
  { key: "videoLength", label: "Video Length" },
  { key: "transitions", label: "Transitions" },
  { key: "musicFit", label: "Music Fit" },
  { key: "musicVolume", label: "Music Volume" },
  { key: "aspectRatioHandling", label: "Aspect Ratio Handling" },
  { key: "narrativeFlow", label: "Narrative Flow" },
  { key: "textOverlays", label: "Text Overlays" },
];

const ISSUE_OPTIONS = [
  "Too long",
  "Bad cuts",
  "Wrong music",
  "Poor asset selection",
  "Other",
];

export default function CompositionFeedbackPanel({
  compositionId,
  script,
  userIntent,
  musicPrompt,
  musicModel,
  selectedAssetIds,
  outputDuration,
  costDIEM,
  onSubmitted,
}: CompositionFeedbackProps) {
  const [step, setStep] = useState<"production" | "details" | "submitted">("production");
  const [productionWorthy, setProductionWorthy] = useState<boolean | null>(null);
  const [biggestIssue, setBiggestIssue] = useState("");
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [likedMost, setLikedMost] = useState("");
  const [wouldChange, setWouldChange] = useState("");
  const [estimatedImpressions, setEstimatedImpressions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleProductionChoice = (worthy: boolean) => {
    setProductionWorthy(worthy);
    if (worthy) {
      setStep("details");
    } else {
      setStep("details");
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/feedback/composition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compositionId,
          productionWorthy: productionWorthy === true,
          ratings,
          userIntent,
          generatedScript: script,
          musicPrompt,
          musicModel,
          selectedAssetIds,
          outputDuration,
          freeformNotes: biggestIssue ? `Biggest issue: ${biggestIssue}` : undefined,
          likedMost: likedMost || undefined,
          wouldChange: wouldChange || undefined,
          estimatedImpressions: estimatedImpressions ? parseInt(estimatedImpressions) : undefined,
          costDIEM,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStep("submitted");
        onSubmitted?.();
      } else {
        setError(data.error || "Failed to save feedback");
      }
    } catch {
      setError("Network error — please retry");
    } finally {
      setSaving(false);
    }
  };

  const allSlidersFilled = RATING_DIMENSIONS.every((d) => typeof ratings[d.key] === "number");

  if (step === "submitted") {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-4">
        <p className="text-sm font-medium text-green-800">Thanks for your feedback!</p>
        <p className="text-xs text-green-600 mt-0.5">
          Your input helps the AI improve future compositions.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-zinc-200 p-5">
      <h3 className="text-sm font-semibold text-zinc-900 mb-4">Rate This Composition</h3>

      {/* Step 1: Production worthy */}
      {step === "production" && (
        <div>
          <p className="text-sm text-zinc-600 mb-3">
            Would you use this for production?
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => handleProductionChoice(true)}
              className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
            >
              Yes
            </button>
            <button
              onClick={() => handleProductionChoice(false)}
              className="flex-1 px-4 py-2.5 bg-zinc-100 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-200"
            >
              No
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Details */}
      {step === "details" && (
        <div className="space-y-4">
          {/* If No: biggest issue */}
          {productionWorthy === false && (
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">
                What was the biggest issue?
              </label>
              <div className="flex flex-wrap gap-2">
                {ISSUE_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setBiggestIssue(opt)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      biggestIssue === opt
                        ? "bg-red-100 text-red-700 border border-red-200"
                        : "bg-zinc-100 text-zinc-600 border border-transparent hover:bg-zinc-200"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* If Yes: 1-5 sliders */}
          {productionWorthy === true && (
            <div className="space-y-3">
              {RATING_DIMENSIONS.map((dim) => (
                <div key={dim.key}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-zinc-700">{dim.label}</label>
                    <span className="text-xs text-zinc-500 font-mono">
                      {ratings[dim.key] ?? "—"}/5
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={ratings[dim.key] ?? 3}
                    onChange={(e) =>
                      setRatings((prev) => ({
                        ...prev,
                        [dim.key]: parseInt(e.target.value),
                      }))
                    }
                    className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-[var(--accent)]"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Optional text fields */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              What did you like most?
            </label>
            <textarea
              value={likedMost}
              onChange={(e) => setLikedMost(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent resize-y"
              placeholder="Optional..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              What would you change?
            </label>
            <textarea
              value={wouldChange}
              onChange={(e) => setWouldChange(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent resize-y"
              placeholder="Optional..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">
              Estimated social media impressions
            </label>
            <input
              type="number"
              value={estimatedImpressions}
              onChange={(e) => setEstimatedImpressions(e.target.value)}
              className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent"
              placeholder="Optional — e.g. 5000"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-3">
            <button
              onClick={() => setStep("production")}
              className="flex-1 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50"
            >
              Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving || (productionWorthy === false && !biggestIssue)}
              className="flex-1 px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Submit Feedback"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
