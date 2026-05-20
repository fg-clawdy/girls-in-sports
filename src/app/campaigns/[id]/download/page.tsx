"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface CampaignData {
  id: string;
  name: string;
  status: string;
  targetFormat: string;
  brief: string | null;
  energyPreset: string;
  finalVideoUrl: string | null;
  proxyVideoUrl: string | null;
  musicUrl: string | null;
  musicPrompt: string | null;
  scriptJson: any;
  userFeedbackJson: any;
  event: {
    id: string;
    name: string;
    sport: string;
    city: string;
    eventDate: string;
  };
}

interface CampaignClip {
  id: string;
  assetId: string;
  order: number;
  startTimeMs: number | null;
  endTimeMs: number | null;
  narrativeLabel: string | null;
  durationSeconds: number;
}

export default function DownloadPage() {
  const { id } = useParams();
  const router = useRouter();
  const campaignId = Array.isArray(id) ? id[0] : id;

  const [campaign, setCampaign] = useState<CampaignData | null>(null);
  const [clips, setClips] = useState<CampaignClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [downloading, setDownloading] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [shareCopied, setShareCopied] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);

  // Feedback state
  const [productionWorthy, setProductionWorthy] = useState<boolean | null>(null);
  const [overallRating, setOverallRating] = useState<number | null>(null);
  const [wouldChange, setWouldChange] = useState("");
  const [musicSatisfied, setMusicSatisfied] = useState<boolean | null>(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);

  const fetchCampaign = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`);
      if (!res.ok) throw new Error("Failed to load campaign");
      const data = await res.json();
      setCampaign(data.campaign);
      setClips(data.clips || []);

      // Pre-fill existing feedback
      const post = data.campaign?.userFeedbackJson?.postRender;
      if (post) {
        if (typeof post.productionWorthy === "boolean") setProductionWorthy(post.productionWorthy);
        if (typeof post.overallRating === "number") setOverallRating(post.overallRating);
        if (post.wouldChange) setWouldChange(post.wouldChange);
        if (typeof post.musicSatisfied === "boolean") setMusicSatisfied(post.musicSatisfied);
        if (post.submittedAt) setFeedbackSubmitted(true);
      }
    } catch {
      setError("Failed to load campaign");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchCampaign();
  }, [fetchCampaign]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/download`);
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const fileName = campaign?.name
        ? `${campaign.name.replace(/[^a-zA-Z0-9]/g, "_")}_final.mp4`
        : "final.mp4";
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      setError("Download failed. Try again.");
    } finally {
      setDownloading(false);
    }
  };

  const handleCopyShareLink = async () => {
    if (shareUrl) {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2500);
      return;
    }
    setShareLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/share`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to create share link");
      const data = await res.json();
      setShareUrl(data.shareUrl);
      await navigator.clipboard.writeText(data.shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2500);
    } catch {
      setError("Failed to create share link");
    } finally {
      setShareLoading(false);
    }
  };

  const handleSubmitFeedback = async () => {
    if (productionWorthy === null || overallRating === null) return;
    setFeedbackSubmitting(true);
    try {
      const clipSentiments = clips
        .filter((c) => c.narrativeLabel)
        .map((c) => ({ assetId: c.assetId, sentiment: "neutral" }));

      await fetch(`/api/campaigns/${campaignId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productionWorthy,
          overallRating,
          wouldChange: wouldChange.trim() || null,
          clipSentiments,
          musicSatisfied,
        }),
      });
      setFeedbackSubmitted(true);
    } catch {
      setError("Failed to submit feedback");
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  const handleCreateAnother = async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/create-another`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      if (data.eventId) {
        router.push(`/events/${data.eventId}/curate`);
      } else {
        router.push("/events");
      }
    } catch {
      setError("Failed to navigate");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-500">Loading delivery page...</p>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-red-600">{error || "Campaign not found"}</p>
      </div>
    );
  }

  const script = campaign.scriptJson as any;
  const totalDurationSeconds = clips.reduce(
    (sum, c) => sum + (c.durationSeconds || 0),
    0
  );
  const hasFinal = Boolean(campaign.finalVideoUrl);

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <Link
              href={`/events/${campaign.event.id}`}
              className="text-sm text-zinc-500 hover:text-zinc-900 mb-1 inline-block"
            >
              &larr; Back to Event
            </Link>
            <h1 className="text-2xl font-bold text-zinc-900">{campaign.name}</h1>
            <p className="text-sm text-zinc-500">
              {campaign.event.sport} &middot; {campaign.targetFormat.replace("_", " ")} &middot;{" "}
              <span className="text-emerald-600 font-medium">{campaign.status}</span>
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-8">
        {/* Final video player */}
        {hasFinal ? (
          <div className="bg-black rounded-lg overflow-hidden aspect-[9/16] max-h-[70vh] mx-auto">
            <video
              src={campaign.finalVideoUrl!}
              controls
              className="w-full h-full"
              preload="metadata"
              poster={campaign.proxyVideoUrl || undefined}
            />
          </div>
        ) : (
          <div className="bg-zinc-100 rounded-lg border border-zinc-200 p-12 text-center">
            <p className="text-zinc-500">Final video not ready yet.</p>
            <p className="text-sm text-zinc-400 mt-1">
              Status: <strong>{campaign.status}</strong>
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleDownload}
            disabled={!hasFinal || downloading}
            className="px-6 py-3 rounded-md text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors flex items-center gap-2"
          >
            {downloading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Downloading...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download MP4
              </>
            )}
          </button>

          <button
            onClick={handleCopyShareLink}
            disabled={!hasFinal || shareLoading}
            className="px-6 py-3 rounded-md text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-40 transition-colors flex items-center gap-2 border border-blue-200"
          >
            {shareLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-blue-300 border-t-blue-700 rounded-full animate-spin" />
                Creating...
              </>
            ) : shareCopied ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 0l-6.632-3.316m6.632 3.316l-3.316 6.632" />
                </svg>
                Copy Share Link
              </>
            )}
          </button>

          <button
            onClick={handleCreateAnother}
            className="px-6 py-3 rounded-md text-sm font-medium text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
          >
            Create Another Campaign
          </button>
        </div>

        {/* Metadata summary */}
        <div className="bg-white rounded-lg border border-zinc-200 p-5">
          <h3 className="text-sm font-semibold text-zinc-800 mb-3">Production Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-zinc-400">Duration</p>
              <p className="font-medium text-zinc-900">{totalDurationSeconds.toFixed(1)}s</p>
            </div>
            <div>
              <p className="text-zinc-400">Clips</p>
              <p className="font-medium text-zinc-900">{clips.length}</p>
            </div>
            <div>
              <p className="text-zinc-400">Format</p>
              <p className="font-medium text-zinc-900">{campaign.targetFormat.replace("_", " ")}</p>
            </div>
            <div>
              <p className="text-zinc-400">Energy</p>
              <p className="font-medium text-zinc-900">{campaign.energyPreset}</p>
            </div>
            <div>
              <p className="text-zinc-400">Resolution</p>
              <p className="font-medium text-zinc-900">1080 &times; 1920</p>
            </div>
            <div>
              <p className="text-zinc-400">Codec</p>
              <p className="font-medium text-zinc-900">H.264 High @ L4.0</p>
            </div>
            <div>
              <p className="text-zinc-400">Music</p>
              <p className="font-medium text-zinc-900">
                {campaign.musicUrl && !campaign.musicUrl.startsWith("failed:")
                  ? "Included"
                  : "None"}
              </p>
            </div>
            <div>
              <p className="text-zinc-400">Source</p>
              <p className="font-medium text-zinc-900">{campaign.event.name}</p>
            </div>
          </div>
        </div>

        {/* Clip list */}
        {clips.length > 0 && (
          <div className="bg-white rounded-lg border border-zinc-200 p-5">
            <h3 className="text-sm font-semibold text-zinc-800 mb-3">Clips Used</h3>
            <div className="space-y-2">
              {clips.map((clip, idx) => (
                <div
                  key={clip.id}
                  className="flex items-center justify-between py-2 border-b border-zinc-100 last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-zinc-100 text-zinc-500 text-xs flex items-center justify-center font-medium">
                      {idx + 1}
                    </span>
                    <span className="text-sm text-zinc-700">
                      {clip.narrativeLabel || `Clip ${idx + 1}`}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-400">
                    {(clip.durationSeconds || 0).toFixed(1)}s
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Post-render feedback */}
        <div className="bg-white rounded-lg border border-zinc-200 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-zinc-800">How did we do?</h3>

          {feedbackSubmitted ? (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-2">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-zinc-600">Thank you for your feedback!</p>
            </div>
          ) : (
            <>
              {/* Production worthy */}
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Is this production-ready?</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setProductionWorthy(true)}
                    className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                      productionWorthy === true
                        ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                        : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    Yes, ship it
                  </button>
                  <button
                    onClick={() => setProductionWorthy(false)}
                    className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                      productionWorthy === false
                        ? "bg-red-50 text-red-700 border-red-300"
                        : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    Not yet
                  </button>
                </div>
              </div>

              {/* Overall rating */}
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Overall rating (1-5)</p>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => setOverallRating(n)}
                      className={`w-10 h-10 rounded-md text-lg font-semibold border transition-colors ${
                        overallRating === n
                          ? "bg-amber-50 text-amber-700 border-amber-300"
                          : "bg-white text-zinc-400 border-zinc-200 hover:bg-zinc-50"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Music satisfied */}
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Music fit the vibe?</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setMusicSatisfied(true)}
                    className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                      musicSatisfied === true
                        ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                        : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    👍 Yes
                  </button>
                  <button
                    onClick={() => setMusicSatisfied(false)}
                    className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                      musicSatisfied === false
                        ? "bg-red-50 text-red-700 border-red-300"
                        : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    👎 No
                  </button>
                </div>
              </div>

              {/* Would change */}
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">
                  What would you change? <span className="text-zinc-400">(optional)</span>
                </p>
                <textarea
                  value={wouldChange}
                  onChange={(e) => setWouldChange(e.target.value)}
                  placeholder="e.g., shorter intro, different music, more action..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-md border border-zinc-200 text-sm text-zinc-700 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                />
              </div>

              <button
                onClick={handleSubmitFeedback}
                disabled={productionWorthy === null || overallRating === null || feedbackSubmitting}
                className="px-5 py-2.5 rounded-md text-sm font-semibold text-white bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
              >
                {feedbackSubmitting ? "Submitting..." : "Submit Feedback"}
              </button>
              {(productionWorthy === null || overallRating === null) && (
                <p className="text-xs text-zinc-400">
                  Production-ready and overall rating are required.
                </p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
