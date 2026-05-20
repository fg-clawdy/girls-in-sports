"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface CampaignData {
  id: string;
  name: string;
  status: string;
  targetFormat: string;
  brief: string | null;
  energyPreset: string;
  proxyVideoUrl: string | null;
  musicUrl: string | null;
  userFeedbackJson: any;
  event: {
    id: string;
    name: string;
    sport: string;
    city: string;
    eventDate: string;
  };
  scriptJson: any;
}

interface CampaignClip {
  id: string;
  assetId: string;
  order: number;
  startTimeMs: number | null;
  endTimeMs: number | null;
  narrativeLabel: string | null;
  durationSeconds: number;
  compositeScore: number | null;
  immichAssetId: string | null;
}

type OverallRating = "ready" | "needs-adjustment" | null;

export default function PreviewPage() {
  const { id } = useParams();
  const router = useRouter();
  const campaignId = Array.isArray(id) ? id[0] : id;

  const [campaign, setCampaign] = useState<CampaignData | null>(null);
  const [clips, setClips] = useState<CampaignClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [overallRating, setOverallRating] = useState<OverallRating>(null);
  const [clipFeedback, setClipFeedback] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);

  const fetchCampaign = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`);
      if (!res.ok) throw new Error("Failed to load campaign");
      const data = await res.json();
      setCampaign(data.campaign);
      setClips(data.clips || []);
      // Restore existing feedback
      if (data.campaign.userFeedbackJson) {
        const fb = data.campaign.userFeedbackJson as any;
        if (fb.overallRating) setOverallRating(fb.overallRating);
        if (fb.clipFeedback) setClipFeedback(fb.clipFeedback);
      }
    } catch {
      setError("Failed to load campaign preview");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchCampaign();
  }, [fetchCampaign]);

  const handleClipFeedback = (clipId: string, sentiment: string) => {
    setClipFeedback((prev) => ({ ...prev, [clipId]: sentiment }));
  };

  const handleSeekToClip = (startMs: number | null) => {
    if (videoRef.current && startMs !== null) {
      videoRef.current.currentTime = startMs / 1000;
      videoRef.current.play();
    }
  };

  const handleSubmitFeedback = async () => {
    if (!overallRating) return;
    setSubmitting(true);
    try {
      await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userFeedbackJson: {
            overallRating,
            clipFeedback,
            submittedAt: new Date().toISOString(),
          },
        }),
      });
    } catch {
      setError("Failed to save feedback");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async () => {
    if (!overallRating) return;
    setSubmitting(true);
    try {
      await fetch(`/api/campaigns/${campaignId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      router.push(`/campaigns/${campaignId}/download`);
    } catch {
      setError("Failed to approve");
      setSubmitting(false);
    }
  };

  const handleRegenerateMusic = async () => {
    try {
      await fetch(`/api/campaigns/${campaignId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate-music" }),
      });
      alert("Music regeneration queued. Check back in a few minutes.");
    } catch {
      setError("Failed to queue music regeneration");
    }
  };

  const handleStartOver = async () => {
    try {
      await fetch(`/api/campaigns/${campaignId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start-over" }),
      });
      if (campaign?.event?.id) {
        router.push(`/events/${campaign.event.id}/curate`);
      } else {
        router.push("/events");
      }
    } catch {
      setError("Failed to reset");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-500">Loading preview...</p>
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

  const hasProxy = Boolean(campaign.proxyVideoUrl);
  const hasMusic = Boolean(campaign.musicUrl);
  const script = campaign.scriptJson as any;

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <Link
              href={`/events/${campaign.event ? "unknown" : ""}`}
              className="text-sm text-zinc-500 hover:text-zinc-900 mb-1 inline-block"
            >
              &larr; Back
            </Link>
            <h1 className="text-2xl font-bold text-zinc-900">{campaign.name}</h1>
            <p className="text-sm text-zinc-500">
              {campaign.event.sport} &middot; {campaign.targetFormat.replace("_", " ")} &middot;{" "}
              {campaign.status}
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-8">
        {/* Video player */}
        {hasProxy ? (
          <div className="bg-black rounded-lg overflow-hidden aspect-[9/16] max-h-[70vh] mx-auto">
            <video
              ref={videoRef}
              src={campaign.proxyVideoUrl!}
              controls
              className="w-full h-full"
              preload="metadata"
            />
          </div>
        ) : (
          <div className="bg-zinc-100 rounded-lg border border-zinc-200 p-12 text-center">
            <p className="text-zinc-500">Proxy video not ready yet.</p>
            <p className="text-sm text-zinc-400 mt-1">
              Status: <strong>{campaign.status}</strong>
            </p>
          </div>
        )}

        {/* Timeline */}
        {hasProxy && clips.length > 0 && (
          <div className="bg-white rounded-lg border border-zinc-200 p-4">
            <h3 className="text-sm font-semibold text-zinc-800 mb-3">Timeline</h3>
            <div className="flex gap-1 overflow-x-auto pb-2">
              {clips.map((clip, idx) => {
                const dur = clip.durationSeconds || 1;
                const widthPct = Math.max(5, (dur / (script?.totalDurationMs ? script.totalDurationMs / 1000 : 60)) * 100);
                return (
                  <button
                    key={clip.id}
                    onClick={() => handleSeekToClip(clip.startTimeMs)}
                    className="flex-shrink-0 relative group"
                    style={{ width: `${widthPct}%`, minWidth: "60px" }}
                  >
                    <div className="h-8 rounded bg-blue-100 hover:bg-blue-200 transition-colors flex items-center justify-center px-1">
                      <span className="text-[10px] text-blue-800 font-medium truncate">
                        {clip.narrativeLabel || `Clip ${idx + 1}`}
                      </span>
                    </div>
                    <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-zinc-500 whitespace-nowrap">
                      {dur.toFixed(1)}s
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Music section */}
        <div className="bg-white rounded-lg border border-zinc-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-800">Music</h3>
            <button
              onClick={handleRegenerateMusic}
              className="text-xs px-3 py-1.5 rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
            >
              Regenerate Music
            </button>
          </div>
          {hasMusic ? (
            <audio
              src={campaign.musicUrl!}
              controls
              className="w-full h-10"
            />
          ) : (
            <p className="text-sm text-amber-600">
              &#9888; Music generation failed or not complete — proxy rendered without music.
            </p>
          )}
        </div>

        {/* Feedback */}
        <div className="bg-white rounded-lg border border-zinc-200 p-4 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-800">Your Feedback</h3>

          {/* Overall rating */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => setOverallRating("ready")}
              className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                overallRating === "ready"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                  : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
              }`}
            >
              Ready to Post
            </button>
            <button
              onClick={() => setOverallRating("needs-adjustment")}
              className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                overallRating === "needs-adjustment"
                  ? "bg-amber-50 text-amber-700 border-amber-300"
                  : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
              }`}
            >
              Needs Adjustment
            </button>
          </div>

          {/* Per-clip feedback */}
          {clips.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">Per-clip sentiment</p>
              {clips.map((clip) => (
                <div
                  key={clip.id}
                  className="flex items-center justify-between py-2 border-b border-zinc-100 last:border-0"
                >
                  <span className="text-sm text-zinc-700 truncate flex-1">
                    {clip.narrativeLabel || `Clip ${clip.order + 1}`}
                  </span>
                  <div className="flex gap-1">
                    {[
                      { emoji: "👍", label: "like" },
                      { emoji: "👎", label: "dislike" },
                      { emoji: "✂️", label: "too-long" },
                      { emoji: "⚡", label: "too-short" },
                    ].map((btn) => (
                      <button
                        key={btn.label}
                        onClick={() => handleClipFeedback(clip.id, btn.label)}
                        className={`w-8 h-8 rounded flex items-center justify-center text-sm transition-colors ${
                          clipFeedback[clip.id] === btn.label
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : "bg-zinc-50 text-zinc-400 hover:bg-zinc-100"
                        }`}
                        title={btn.label}
                      >
                        {btn.emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleApprove}
              disabled={!overallRating || submitting}
              className="px-5 py-2.5 rounded-md text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {submitting ? "Approving..." : "Approve for Final Render"}
            </button>
            <button
              onClick={handleStartOver}
              className="px-5 py-2.5 rounded-md text-sm font-medium text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
            >
              Start Over
            </button>
          </div>
          {!overallRating && (
            <p className="text-xs text-red-500">Select an overall rating to enable approval.</p>
          )}
        </div>
      </main>
    </div>
  );
}
