"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface ClipData {
  id: string;
  immichAssetId: string | null;
  durationSeconds: number | null;
  type: string;
  status: string;
  clipScore: {
    compositeScore: number | null;
    clipType: string | null;
    visionScore: number | null;
    audioScore: number | null;
    motionScore: number | null;
    transcriptExcerpt: string | null;
  } | null;
  assetTags: Array<{ tag: string; source: string; confidence: number | null }>;
}

interface EventData {
  id: string;
  name: string;
  sport: string;
  city: string;
  eventDate: string;
  description: string | null;
}

const FORMAT_OPTIONS: { value: string; label: string; duration: number }[] = [
  { value: "REEL_15", label: "15s Reel", duration: 15 },
  { value: "REEL_30", label: "30s Reel", duration: 30 },
  { value: "REEL_60", label: "60s Reel", duration: 60 },
  { value: "AD_15", label: "15s Ad", duration: 15 },
  { value: "AD_30", label: "30s Ad", duration: 30 },
  { value: "HIGHLIGHT_60", label: "60s Highlight", duration: 60 },
];

const ENERGY_OPTIONS: { value: string; label: string }[] = [
  { value: "HYPE", label: "Hype" },
  { value: "INSPIRATIONAL", label: "Inspirational" },
  { value: "EMOTIONAL", label: "Emotional" },
  { value: "INSTRUCTIONAL", label: "Instructional" },
];

const SPORT_BRIEF_EXAMPLES: Record<string, string> = {
  basketball: "Focus on fast breaks and player reactions. High intensity.",
  soccer: "Show team chemistry and goal celebrations. Emotional arc.",
  volleyball: "Spikes and digs. Emphasize athleticism and hustle.",
  default: "Highlight key moments, energy, and team spirit.",
};

function scoreBadgeColor(score: number | null) {
  if (score === null || score === undefined) return "bg-zinc-200 text-zinc-500";
  if (score >= 70) return "bg-emerald-100 text-emerald-700 border-emerald-300";
  if (score >= 40) return "bg-amber-100 text-amber-700 border-amber-300";
  return "bg-red-100 text-red-700 border-red-300";
}

export default function CuratePage() {
  const { id } = useParams();
  const router = useRouter();
  const eventId = Array.isArray(id) ? id[0] : id;

  const [event, setEvent] = useState<EventData | null>(null);
  const [clips, setClips] = useState<ClipData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [acceptedMap, setAcceptedMap] = useState<Record<string, boolean>>({});
  const [mustIncludeMap, setMustIncludeMap] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState<"score" | "duration" | "type">("score");

  const [brief, setBrief] = useState("");
  const [targetFormat, setTargetFormat] = useState("");
  const [energyPreset, setEnergyPreset] = useState("HYPE");
  const [creating, setCreating] = useState(false);

  const fetchClips = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/clips`);
      if (!res.ok) throw new Error("Failed to load clips");
      const data = await res.json();
      setEvent(data.event);
      setClips(data.clips);
      // Default accept all with score >= 50
      const map: Record<string, boolean> = {};
      data.clips.forEach((c: ClipData) => {
        map[c.id] = (c.clipScore?.compositeScore ?? 0) >= 50;
      });
      setAcceptedMap(map);
    } catch {
      setError("Failed to load clips");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchClips();
  }, [fetchClips]);

  const allTags = Array.from(
    new Set(clips.flatMap((c) => c.assetTags.map((t) => t.tag)))
  ).sort();

  const filteredClips = clips.filter((clip) => {
    // Tag AND logic
    if (selectedTags.size > 0) {
      const clipTags = new Set(clip.assetTags.map((t) => t.tag));
      for (const tag of selectedTags) {
        if (!clipTags.has(tag)) return false;
      }
    }
    // Search (Immich smart search not wired here — simple local filter on tags + transcript)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const inTags = clip.assetTags.some((t) => t.tag.toLowerCase().includes(q));
      const inTranscript = (clip.clipScore?.transcriptExcerpt ?? "").toLowerCase().includes(q);
      if (!inTags && !inTranscript) return false;
    }
    return true;
  });

  const sortedClips = [...filteredClips].sort((a, b) => {
    if (sortBy === "score") {
      return (b.clipScore?.compositeScore ?? 0) - (a.clipScore?.compositeScore ?? 0);
    }
    if (sortBy === "duration") {
      return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
    }
    return (a.clipScore?.clipType ?? "").localeCompare(b.clipScore?.clipType ?? "");
  });

  const acceptedCount = sortedClips.filter((c) => acceptedMap[c.id]).length;
  const mustIncludeIds = sortedClips.filter((c) => mustIncludeMap[c.id]).map((c) => c.id);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const toggleAccept = (clipId: string) => {
    setAcceptedMap((prev) => ({ ...prev, [clipId]: !prev[clipId] }));
  };

  const toggleMustInclude = (clipId: string) => {
    setMustIncludeMap((prev) => ({ ...prev, [clipId]: !prev[clipId] }));
  };

  const selectAll = () => {
    const map: Record<string, boolean> = {};
    sortedClips.forEach((c) => (map[c.id] = true));
    setAcceptedMap((prev) => ({ ...prev, ...map }));
  };

  const createCampaign = async () => {
    if (!targetFormat) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/events/${eventId}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: brief.trim(),
          targetFormat,
          energyPreset,
          selectedAssetIds: sortedClips.filter((c) => acceptedMap[c.id]).map((c) => c.id),
          mustIncludeAssetIds: mustIncludeIds,
        }),
      });
      if (!res.ok) throw new Error("Failed to create campaign");
      const data = await res.json();
      router.push(`/campaigns/${data.campaign.id}`);
    } catch {
      setError("Failed to create campaign");
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-500">Loading clips...</p>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-red-600">{error || "Event not found"}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <Link href={`/events/${eventId}`} className="text-sm text-zinc-500 hover:text-zinc-900 mb-2 inline-block">
            &larr; Back to Event
          </Link>
          <h1 className="text-2xl font-bold text-zinc-900">Curate: {event.name}</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {event.sport} &middot; {event.city} &middot; {new Date(event.eventDate).toLocaleDateString()}
          </p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left sidebar: filters + brief */}
        <aside className="lg:col-span-1 space-y-6">
          {/* Search */}
          <div>
            <label className="text-sm font-medium text-zinc-700 block mb-1">Search clips</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Keywords, transcript..."
              className="w-full px-3 py-2 rounded-md border border-zinc-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Tag filters */}
          {allTags.length > 0 && (
            <div>
              <label className="text-sm font-medium text-zinc-700 block mb-2">Filter by tags</label>
              <div className="flex flex-wrap gap-2">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      selectedTags.has(tag)
                        ? "bg-blue-50 text-blue-700 border-blue-300"
                        : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
              {selectedTags.size > 0 && (
                <button
                  onClick={() => setSelectedTags(new Set())}
                  className="text-xs text-zinc-400 hover:text-zinc-600 mt-2 underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* Sort */}
          <div>
            <label className="text-sm font-medium text-zinc-700 block mb-1">Sort by</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="w-full px-3 py-2 rounded-md border border-zinc-300 text-sm bg-white"
            >
              <option value="score">Composite Score</option>
              <option value="duration">Duration</option>
              <option value="type">Clip Type</option>
            </select>
          </div>

          {/* Stats */}
          <div className="bg-white rounded-lg border border-zinc-200 p-4">
            <p className="text-sm text-zinc-600">
              <strong className="text-zinc-900">{sortedClips.length}</strong> clips shown
            </p>
            <p className="text-sm text-zinc-600 mt-1">
              <strong className="text-zinc-900">{acceptedCount}</strong> accepted
            </p>
            <p className="text-sm text-zinc-600 mt-1">
              <strong className="text-zinc-900">{mustIncludeIds.length}</strong> must-include
            </p>
          </div>

          {/* Creative Brief */}
          <div className="bg-white rounded-lg border border-zinc-200 p-4 space-y-4">
            <h3 className="font-semibold text-zinc-900">Creative Brief</h3>
            <div>
              <label className="text-xs font-medium text-zinc-600 block mb-1">Brief (max 500 chars)</label>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value.slice(0, 500))}
                placeholder={SPORT_BRIEF_EXAMPLES[event.sport?.toLowerCase()] ?? SPORT_BRIEF_EXAMPLES.default}
                rows={4}
                className="w-full px-3 py-2 rounded-md border border-zinc-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <p className="text-xs text-zinc-400 mt-1 text-right">{brief.length}/500</p>
            </div>

            <div>
              <label className="text-xs font-medium text-zinc-600 block mb-1">Target Format</label>
              <select
                value={targetFormat}
                onChange={(e) => setTargetFormat(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-zinc-300 text-sm bg-white"
              >
                <option value="">Select format...</option>
                {FORMAT_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-zinc-600 block mb-1">Energy</label>
              <div className="flex flex-wrap gap-2">
                {ENERGY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setEnergyPreset(opt.value)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                      energyPreset === opt.value
                        ? "bg-blue-50 text-blue-700 border-blue-300"
                        : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={createCampaign}
              disabled={acceptedCount < 3 || !targetFormat || creating}
              className="w-full py-2.5 rounded-md text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? "Creating Campaign..." : "Create Campaign"}
            </button>
            {acceptedCount < 3 && (
              <p className="text-xs text-red-500">Accept at least 3 clips to create a campaign.</p>
            )}
          </div>
        </aside>

        {/* Right: clip grid */}
        <section className="lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-zinc-900">Scored Clips</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50"
              >
                Accept All &ge;50
              </button>
            </div>
          </div>

          {sortedClips.length === 0 ? (
            <div className="text-center py-20 bg-white rounded-lg border border-zinc-200">
              <p className="text-zinc-500">
                {clips.length === 0 ? "No scored clips yet. Upload footage and wait for ingest + scoring." : "No clips match your filters."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {sortedClips.map((clip) => {
                const score = clip.clipScore?.compositeScore ?? null;
                const type = clip.clipScore?.clipType ?? "UNKNOWN";
                const accepted = acceptedMap[clip.id] ?? false;
                const must = mustIncludeMap[clip.id] ?? false;
                return (
                  <div
                    key={clip.id}
                    className={`bg-white rounded-lg border transition-all overflow-hidden ${
                      accepted ? "border-zinc-200" : "border-zinc-200 opacity-60"
                    }`}
                  >
                    {/* Thumbnail */}
                    <div className="aspect-video relative bg-zinc-100">
                      {clip.immichAssetId ? (
                        <img
                          src={`/api/immich/thumbnail/${clip.immichAssetId}`}
                          alt="Clip thumbnail"
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-400 text-sm">
                          No thumbnail
                        </div>
                      )}
                      {/* Score badge */}
                      {score !== null && (
                        <span
                          className={`absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold border ${scoreBadgeColor(
                            score
                          )}`}
                        >
                          {score.toFixed(1)}
                        </span>
                      )}
                      {/* Duration */}
                      {clip.durationSeconds && (
                        <span className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded">
                          {clip.durationSeconds.toFixed(1)}s
                        </span>
                      )}
                    </div>

                    {/* Info */}
                    <div className="p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-zinc-700 uppercase tracking-wide">
                          {type}
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-zinc-400">
                            V:{(clip.clipScore?.visionScore ?? 0).toFixed(0)}
                          </span>
                          <span className="text-[10px] text-zinc-400">
                            A:{(clip.clipScore?.audioScore ?? 0).toFixed(0)}
                          </span>
                          <span className="text-[10px] text-zinc-400">
                            M:{(clip.clipScore?.motionScore ?? 0).toFixed(0)}
                          </span>
                        </div>
                      </div>

                      {/* Tags */}
                      {clip.assetTags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {clip.assetTags.slice(0, 6).map((t) => (
                            <span
                              key={t.tag}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600"
                            >
                              {t.tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Transcript */}
                      {clip.clipScore?.transcriptExcerpt && (
                        <p className="text-xs text-zinc-500 line-clamp-2 italic">
                          &ldquo;{clip.clipScore.transcriptExcerpt}&rdquo;
                        </p>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => toggleAccept(clip.id)}
                          className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                            accepted
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                              : "bg-zinc-100 text-zinc-500 border border-zinc-200 hover:bg-zinc-200"
                          }`}
                        >
                          {accepted ? "Accepted" : "Rejected"}
                        </button>
                        <button
                          onClick={() => toggleMustInclude(clip.id)}
                          title="Must Include"
                          className={`px-2 py-1.5 rounded-md text-xs font-bold border transition-colors ${
                            must
                              ? "bg-amber-50 text-amber-700 border-amber-300"
                              : "bg-white text-zinc-400 border-zinc-200 hover:text-amber-600"
                          }`}
                        >
                          &#9733;
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
