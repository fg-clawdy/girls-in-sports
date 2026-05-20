"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

// ── Types ────────────────────────────────────────────────────────────

interface EventData {
  id: string;
  name: string;
  sport: string;
  city: string;
  eventDate: string;
  description: string | null;
  immichAlbumId: string | null;
  qualityTier: "AMATEUR" | "INTERMEDIATE" | "PROFESSIONAL";
}

interface ImmichAsset {
  id: string;
  type: string;
  originalFileName: string;
  fileCreatedAt: string;
  duration?: string;
  exifInfo?: {
    city?: string;
    description?: string;
  };
}

interface ImmichAlbum {
  id: string;
  albumName: string;
  assetCount: number;
  assets: ImmichAsset[];
}

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

interface JobItem {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryAfter: string | null;
  parentJobId: string | null;
}

// ── Constants ────────────────────────────────────────────────────────

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

const JOB_TYPE_LABELS: Record<string, string> = {
  INGEST_CLIP: "Scene Detection",
  SCORE_CLIP: "AI Scoring",
  DIRECT_SCRIPT: "Script Generation",
  GENERATE_MUSIC: "Music Generation",
  RENDER_PROXY: "Proxy Render",
  RENDER_FINAL: "Final Render",
};

const POLL_INTERVAL = 5000;

const TIER_OPTIONS: { value: string; label: string; threshold: number; desc: string }[] = [
  { value: "AMATEUR", label: "Amateur", threshold: 0, desc: "All clips visible" },
  { value: "INTERMEDIATE", label: "Intermediate", threshold: 25, desc: "≥25 score" },
  { value: "PROFESSIONAL", label: "Professional", threshold: 50, desc: "≥50 score" },
];

function getTierThreshold(tier: string): number {
  return TIER_OPTIONS.find((t) => t.value === tier)?.threshold ?? 50;
}

// ── Helpers ──────────────────────────────────────────────────────────

function scoreBadgeColor(score: number | null) {
  if (score === null || score === undefined) return "bg-zinc-200 text-zinc-500";
  if (score >= 70) return "bg-emerald-100 text-emerald-700 border-emerald-300";
  if (score >= 40) return "bg-amber-100 text-amber-700 border-amber-300";
  return "bg-red-100 text-red-700 border-red-300";
}

function getStatusBadge(status: string) {
  switch (status) {
    case "QUEUED":
      return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-600">Queued</span>;
    case "RUNNING":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          Running
        </span>
      );
    case "RETRYING":
      return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700">Retrying</span>;
    case "DONE":
      return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700">Done</span>;
    case "FAILED":
      return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-700">Failed</span>;
    default:
      return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-600">{status}</span>;
  }
}

function formatDuration(startedAt: string | null) {
  if (!startedAt) return "—";
  const diff = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

// ── Component ────────────────────────────────────────────────────────

export default function EventPage() {
  const { id } = useParams();
  const eventId = Array.isArray(id) ? id[0] : id;

  // ── Event & Album ──
  const [event, setEvent] = useState<EventData | null>(null);
  const [album, setAlbum] = useState<ImmichAlbum | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // ── Upload ──
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [showUploadToast, setShowUploadToast] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Curate ──
  const [clips, setClips] = useState<ClipData[]>([]);
  const [clipsLoading, setClipsLoading] = useState(true);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [acceptedMap, setAcceptedMap] = useState<Record<string, boolean>>({});
  const [mustIncludeMap, setMustIncludeMap] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState<"score" | "duration" | "type">("score");
  const [brief, setBrief] = useState("");
  const [targetFormat, setTargetFormat] = useState("");
  const [energyPreset, setEnergyPreset] = useState("HYPE");
  const [creating, setCreating] = useState(false);

  // ── Active Jobs ──
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);

  // ── All Media (collapsed by default) ──
  const [showAllMedia, setShowAllMedia] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<"all" | "image" | "video">("all");

  // ── Lightbox ──
  const [lightboxAsset, setLightboxAsset] = useState<ImmichAsset | null>(null);

  // ── Edit Event Modal ──
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", sport: "", city: "", eventDate: "", description: "" });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");

  // ── Delete Asset ──
  const [deleteTarget, setDeleteTarget] = useState<{ assetId: string; fileName: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ── Data fetching ──

  const fetchEventData = useCallback(async () => {
    try {
      const eventRes = await fetch(`/api/events/${eventId}`);
      if (!eventRes.ok) throw new Error("Failed to load event");
      const eventData = await eventRes.json();
      setEvent(eventData.event);

      if (eventData.event.immichAlbumId) {
        const albumRes = await fetch(`/api/immich/albums/${eventData.event.immichAlbumId}`, { cache: "no-store" });
        if (albumRes.ok) {
          const albumData = await albumRes.json();
          setAlbum(albumData.album);
        }
      }
    } catch {
      setError("Failed to load event data");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  const fetchClips = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/clips`);
      if (!res.ok) throw new Error("Failed to load clips");
      const data = await res.json();
      setClips(data.clips || []);
      const threshold = getTierThreshold(data.event?.qualityTier ?? "PROFESSIONAL");
      const map: Record<string, boolean> = {};
      data.clips.forEach((c: ClipData) => {
        map[c.id] = (c.clipScore?.compositeScore ?? 0) >= threshold;
      });
      setAcceptedMap(map);
    } catch {
      // clips may not exist yet — that's ok
      setClips([]);
    } finally {
      setClipsLoading(false);
    }
  }, [eventId]);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/jobs`);
      if (!res.ok) return;
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {
      // silently fail — jobs are enhancement
    }
  }, [eventId]);

  useEffect(() => {
    fetchEventData();
    fetchClips();
    fetchJobs();
  }, [fetchEventData, fetchClips, fetchJobs]);

  // Auto-poll jobs every 5s when there are active jobs
  const hasActiveJobs = jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING" || j.status === "RETRYING");
  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = setInterval(() => {
      fetchJobs();
      fetchClips(); // also refresh clips as jobs complete
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [hasActiveJobs, fetchJobs, fetchClips]);

  // Upload toast timer
  useEffect(() => {
    if (!showUploadToast) return;
    const timer = setTimeout(() => setShowUploadToast(false), 6000);
    return () => clearTimeout(timer);
  }, [showUploadToast]);

  // ── Upload handlers ──

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadErrors([]);
    setUploadProgress({});
    const fileList = Array.from(files);
    try {
      await Promise.all(
        fileList.map(
          (file) =>
            new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              const formData = new FormData();
              formData.append("files", file);
              xhr.upload.addEventListener("progress", (e) => {
                if (e.lengthComputable) {
                  const pct = Math.round((e.loaded / e.total) * 100);
                  setUploadProgress((prev) => ({ ...prev, [file.name]: pct }));
                }
              });
              xhr.addEventListener("load", () => {
                setUploadProgress((prev) => ({ ...prev, [file.name]: 100 }));
                if (xhr.status >= 200 && xhr.status < 300) {
                  resolve();
                } else {
                  reject(new Error(`${file.name}: ${xhr.statusText || "Upload failed"}`));
                }
              });
              xhr.addEventListener("error", () => reject(new Error(`${file.name}: Network error`)));
              xhr.addEventListener("abort", () => reject(new Error(`${file.name}: Aborted`)));
              xhr.open("POST", `/api/events/${eventId}/upload`);
              xhr.send(formData);
            })
        )
      );
      setShowUploadToast(true);
      await fetchEventData();
      await fetchClips();
      await fetchJobs();
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload error";
      setUploadErrors((prev) => [...prev, msg]);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleUpload(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // ── Curate actions ──

  const allTags = Array.from(new Set(clips.flatMap((c) => c.assetTags.map((t) => t.tag)))).sort();

  const filteredClips = clips.filter((clip) => {
    if (selectedTags.size > 0) {
      const clipTags = new Set(clip.assetTags.map((t) => t.tag));
      for (const tag of selectedTags) {
        if (!clipTags.has(tag)) return false;
      }
    }
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

  const selectAllAccepted = () => {
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
      window.location.href = `/campaigns/${data.campaign.id}/preview`;
    } catch {
      setError("Failed to create campaign");
      setCreating(false);
    }
  };

  // ── Active Jobs actions ──

  const handleRetryJob = async (jobId: string) => {
    setRetryingJobId(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      await fetchJobs();
    } catch {
      setError("Failed to retry job");
    } finally {
      setRetryingJobId(null);
    }
  };

  // ── Edit Event ──

  const openEditModal = () => {
    if (!event) return;
    setEditForm({
      name: event.name,
      sport: event.sport,
      city: event.city,
      eventDate: event.eventDate ? new Date(event.eventDate).toISOString().split("T")[0] : "",
      description: event.description || "",
    });
    setEditError("");
    setShowEditModal(true);
  };

  const handleEditEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!event) return;
    setEditLoading(true);
    setEditError("");
    try {
      const body: Record<string, unknown> = {};
      if (editForm.name.trim()) body.name = editForm.name.trim();
      if (editForm.sport.trim()) body.sport = editForm.sport.trim();
      if (editForm.city.trim()) body.city = editForm.city.trim();
      if (editForm.eventDate) body.eventDate = editForm.eventDate;
      if (editForm.description.trim()) body.description = editForm.description.trim();

      const res = await fetch(`/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update");
      setShowEditModal(false);
      await fetchEventData();
    } catch (err: any) {
      setEditError(err.message);
    } finally {
      setEditLoading(false);
    }
  };

  // ── Delete Asset ──

  const handleDeleteAsset = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/events/${eventId}/assets/${deleteTarget.assetId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      setDeleteTarget(null);
      await fetchEventData();
    } catch (err: any) {
      alert("Failed to delete: " + err.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  // ── Filtered media ──

  const filteredAssets = album?.assets.filter((asset) => {
    if (mediaFilter === "all") return true;
    return asset.type.toLowerCase() === mediaFilter;
  }) || [];

  // ── Render ──

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <p className="text-zinc-500">Loading event...</p>
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
    <div className="min-h-screen bg-zinc-50 pb-20" onDrop={handleDrop} onDragOver={handleDragOver}>
      {/* ── Header ── */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-6xl mx-auto">
          <Link href="/dashboard" className="text-sm text-zinc-500 hover:text-zinc-900 mb-2 inline-block">
            &larr; Back to Dashboard
          </Link>
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-zinc-900">{event.name}</h1>
            <button
              onClick={openEditModal}
              className="text-sm px-3 py-1.5 rounded-md bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 transition-colors"
            >
              Edit Event
            </button>
          </div>
          <div className="flex items-center gap-3 mt-2 text-sm text-zinc-600">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 font-medium">
              {event.sport}
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
              {event.city}
            </span>
            <span>
              {new Date(event.eventDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </span>
          </div>
          {event.description && <p className="text-zinc-600 mt-2">{event.description}</p>}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-8">
        {/* ═══════════════════════════════════════════════════════════
            SECTION 1: UPLOAD
           ═══════════════════════════════════════════════════════════ */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-800 mb-3">Upload Media</h2>
          <div className="bg-white rounded-lg border border-zinc-200 p-6">
            <div className="flex items-center gap-4">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => handleUpload(e.target.files)}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                {uploading ? "Uploading..." : "+ Choose Files"}
              </button>
              <p className="text-sm text-zinc-500">or drag and drop files here</p>
            </div>

            {/* Upload progress */}
            {uploading && Object.keys(uploadProgress).length > 0 && (
              <div className="mt-4 space-y-2">
                {Object.entries(uploadProgress).map(([name, pct]) => (
                  <div key={name} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-600 w-32 truncate flex-shrink-0" title={name}>
                      {name}
                    </span>
                    <div className="flex-1 h-2 bg-zinc-100 rounded-full overflow-hidden">
                      <div className="h-full bg-[var(--accent)] rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-zinc-500 w-8 text-right">{pct}%</span>
                  </div>
                ))}
              </div>
            )}

            {/* Upload errors */}
            {uploadErrors.length > 0 && (
              <div className="mt-4 space-y-2">
                {uploadErrors.map((err, i) => (
                  <div key={i} className="flex items-center justify-between bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
                    <p className="text-sm text-red-700">{err}</p>
                    <button
                      onClick={() => setUploadErrors((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-red-500 hover:text-red-700 text-sm ml-3"
                      title="Dismiss"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 2: CURATE (inline from /events/[id]/curate)
           ═══════════════════════════════════════════════════════════ */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-zinc-800">Curate Clips</h2>
            <span className="text-xs text-zinc-500">
              {acceptedCount} accepted · {mustIncludeIds.length} must-include
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Sidebar: filters + brief */}
            <aside className="lg:col-span-1 space-y-5">
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

              {/* Tags */}
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

              {/* Quality Tier */}
              <div>
                <label className="text-sm font-medium text-zinc-700 block mb-1">Quality Tier</label>
                <select
                  value={event?.qualityTier ?? "PROFESSIONAL"}
                  onChange={async (e) => {
                    const newTier = e.target.value;
                    try {
                      const res = await fetch(`/api/events/${eventId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ qualityTier: newTier }),
                      });
                      if (!res.ok) throw new Error("Failed to update tier");
                      setEvent((prev) => prev ? { ...prev, qualityTier: newTier as any } : prev);
                      await fetchClips();
                    } catch {
                      setError("Failed to update quality tier");
                    }
                  }}
                  className="w-full px-3 py-2 rounded-md border border-zinc-300 text-sm bg-white"
                >
                  {TIER_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-zinc-400 mt-1">
                  {TIER_OPTIONS.find((t) => t.value === (event?.qualityTier ?? "PROFESSIONAL"))?.desc}
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

            {/* Clip grid */}
            <section className="lg:col-span-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-zinc-900">
                  Scored Clips
                  <span className="ml-2 text-sm font-normal text-zinc-500">
                    {sortedClips.length} shown
                  </span>
                </h3>
                <button
                  onClick={selectAllAccepted}
                  className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50"
                >
                  Accept All
                </button>
              </div>

              {clipsLoading ? (
                <div className="text-center py-20 bg-white rounded-lg border border-zinc-200">
                  <p className="text-zinc-500">Loading clips...</p>
                </div>
              ) : sortedClips.length === 0 ? (
                <div className="text-center py-20 bg-white rounded-lg border border-zinc-200">
                  <p className="text-zinc-500">
                    {clips.length === 0
                      ? "No scored clips yet. Upload footage and wait for ingest + scoring."
                      : "No clips match your filters."}
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
                          {score !== null && (
                            <span
                              className={`absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold border ${scoreBadgeColor(
                                score
                              )}`}
                            >
                              {score.toFixed(1)}
                            </span>
                          )}
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

                          {clip.clipScore?.transcriptExcerpt && (
                            <p className="text-xs text-zinc-500 line-clamp-2 italic">
                              &ldquo;{clip.clipScore.transcriptExcerpt}&rdquo;
                            </p>
                          )}

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
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════
            SECTION 3: ACTIVE JOBS
           ═══════════════════════════════════════════════════════════ */}
        {jobs.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-800">Active Jobs</h2>
              {hasActiveJobs && (
                <span className="inline-flex items-center gap-1 text-xs text-blue-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  Polling every 5s
                </span>
              )}
              <Link
                href="/dashboard"
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                Full Dashboard →
              </Link>
            </div>

            <div className="bg-white rounded-lg border border-zinc-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-zinc-50 border-b border-zinc-200">
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Type</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Status</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Elapsed</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Attempts</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Error</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-zinc-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {jobs.map((job) => (
                      <tr key={job.id} className="hover:bg-zinc-50 transition-colors">
                        <td className="px-4 py-3 text-zinc-700 font-medium">
                          {JOB_TYPE_LABELS[job.type] || job.type}
                        </td>
                        <td className="px-4 py-3">{getStatusBadge(job.status)}</td>
                        <td className="px-4 py-3 text-zinc-500">
                          {job.status === "RUNNING" ? formatDuration(job.startedAt) : "—"}
                        </td>
                        <td className="px-4 py-3 text-zinc-500">
                          {job.attempts}/{job.maxAttempts}
                        </td>
                        <td className="px-4 py-3">
                          {job.error ? (
                            <span className="text-xs text-red-600 truncate max-w-[200px] block" title={job.error}>
                              {job.error.slice(0, 80)}{job.error.length > 80 ? "..." : ""}
                            </span>
                          ) : (
                            <span className="text-zinc-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {job.status === "FAILED" || job.status === "RETRYING" ? (
                            <button
                              onClick={() => handleRetryJob(job.id)}
                              disabled={retryingJobId === job.id}
                              className="text-xs px-3 py-1.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium disabled:opacity-40 transition-colors"
                            >
                              {retryingJobId === job.id ? "Retrying..." : "Retry"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 4: ALL MEDIA (collapsed by default)
           ═══════════════════════════════════════════════════════════ */}
        <section>
          <button
            onClick={() => setShowAllMedia((prev) => !prev)}
            className="flex items-center gap-2 text-sm font-semibold text-zinc-800 hover:text-zinc-600 transition-colors mb-3"
          >
            <span className="text-xs">{showAllMedia ? "▼" : "▶"}</span>
            All Media
            {album && <span className="text-zinc-500 font-normal">({album.assetCount} assets)</span>}
          </button>

          {showAllMedia && (
            <div className="space-y-4">
              {/* Media filter */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-500">Filter:</span>
                {(["all", "image", "video"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setMediaFilter(f)}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      mediaFilter === f
                        ? "bg-[var(--accent)] text-white"
                        : "bg-white text-zinc-600 border border-zinc-200 hover:bg-zinc-50"
                    }`}
                  >
                    {f === "all" ? "All" : f === "image" ? "Photos" : "Videos"}
                  </button>
                ))}
              </div>

              {/* Media grid */}
              {album && album.assets.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {filteredAssets.map((asset) => (
                    <div
                      key={asset.id}
                      onClick={() => setLightboxAsset(asset)}
                      className="group relative bg-white rounded-lg border border-zinc-200 overflow-hidden hover:shadow-md transition-shadow cursor-pointer"
                    >
                      <div className="aspect-square relative bg-zinc-100">
                        {asset.type === "VIDEO" ? (
                          <>
                            <img
                              src={`/api/immich/thumbnail/${asset.id}`}
                              alt={asset.originalFileName}
                              loading="lazy"
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <svg className="w-12 h-12 text-white/90 drop-shadow-lg" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </div>
                            <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-0.5 rounded">
                              VIDEO
                            </div>
                          </>
                        ) : (
                          <img
                            src={`/api/immich/thumbnail/${asset.id}`}
                            alt={asset.originalFileName}
                            loading="lazy"
                            className="w-full h-full object-cover"
                          />
                        )}
                      </div>
                      <div className="p-2">
                        <p className="text-xs text-zinc-500 truncate" title={asset.originalFileName}>
                          {asset.originalFileName}
                        </p>
                        <p className="text-xs text-zinc-400 mt-0.5">
                          {new Date(asset.fileCreatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : album ? (
                <div className="bg-white rounded-lg border border-zinc-200 p-8 text-center">
                  <p className="text-zinc-500">
                    {mediaFilter !== "all" ? `No ${mediaFilter === "image" ? "photos" : "videos"} found.` : "This album is empty."}
                  </p>
                </div>
              ) : (
                <div className="bg-white rounded-lg border border-zinc-200 p-8 text-center">
                  <p className="text-zinc-500">No Immich album linked to this event.</p>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* ── Upload Toast ── */}
      {showUploadToast && (
        <div className="fixed top-4 right-4 z-50 bg-green-50 border border-green-200 rounded-lg px-4 py-3 shadow-lg max-w-sm animate-in slide-in-from-top-2">
          <div className="flex items-start gap-2">
            <span className="text-green-600 text-lg">✓</span>
            <div>
              <p className="text-sm font-medium text-green-800">Upload complete</p>
              <p className="text-xs text-green-700 mt-0.5">
                Your footage is being processed. We&apos;ll notify you when it&apos;s ready.
              </p>
            </div>
            <button onClick={() => setShowUploadToast(false)} className="text-green-600 hover:text-green-800 text-sm ml-2">
              ×
            </button>
          </div>
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightboxAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90" onClick={() => setLightboxAsset(null)}>
          <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            {lightboxAsset.type === "VIDEO" ? (
              <video
                src={`/api/immich/assets/${lightboxAsset.id}`}
                controls
                autoPlay
                className="max-h-[90vh]"
                style={{ aspectRatio: "9/16" }}
              />
            ) : (
              <img
                src={`/api/immich/assets/${lightboxAsset.id}`}
                alt={lightboxAsset.originalFileName}
                className="max-w-[90vw] max-h-[90vh] object-contain"
              />
            )}
            <div className="absolute bottom-4 left-0 right-0 text-center">
              <p className="text-white/80 text-sm bg-black/50 inline-block px-3 py-1 rounded-full">
                {lightboxAsset.originalFileName}
              </p>
            </div>
            <button
              onClick={() => setLightboxAsset(null)}
              className="absolute top-2 right-2 text-white/80 hover:text-white bg-black/50 hover:bg-black/70 rounded-full w-8 h-8 flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ── Edit Event Modal ── */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowEditModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-900 mb-4">Edit Event</h2>
            <form onSubmit={handleEditEvent} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700">Name</label>
                <input
                  required
                  value={editForm.name}
                  onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-700">Sport</label>
                  <input
                    value={editForm.sport}
                    onChange={(e) => setEditForm((p) => ({ ...p, sport: e.target.value }))}
                    className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700">City</label>
                  <input
                    value={editForm.city}
                    onChange={(e) => setEditForm((p) => ({ ...p, city: e.target.value }))}
                    className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700">Date</label>
                <input
                  type="date"
                  value={editForm.eventDate}
                  onChange={(e) => setEditForm((p) => ({ ...p, eventDate: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700">Description</label>
                <textarea
                  rows={2}
                  value={editForm.description}
                  onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              {editError && <p className="text-sm text-red-600">{editError}</p>}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="text-sm px-4 py-2 rounded-md text-zinc-700 hover:bg-zinc-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editLoading}
                  className="text-sm px-4 py-2 rounded-md bg-[var(--accent)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {editLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-900 mb-2">Remove Media?</h2>
            <p className="text-sm text-zinc-600 mb-4">
              Delete <strong className="text-zinc-900">{deleteTarget.fileName}</strong> from this event? This cannot be undone.
            </p>
            {deleteLoading && <p className="text-sm text-zinc-500 mb-2">Removing...</p>}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-sm px-4 py-2 rounded-md text-zinc-700 hover:bg-zinc-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAsset}
                disabled={deleteLoading}
                className="text-sm px-4 py-2 rounded-md bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
