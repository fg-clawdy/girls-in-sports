"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface EventData {
  id: string;
  name: string;
  sport: string;
  city: string;
  eventDate: string;
  description: string | null;
  immichAlbumId: string | null;
}

interface ImmichAsset {
  id: string;
  type: string;
  originalFileName: string;
  fileCreatedAt: string;
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

type OutputType = "collage" | "highlight" | "wrapup";

export default function EventPage() {
  const { id } = useParams();
  const [event, setEvent] = useState<EventData | null>(null);
  const [album, setAlbum] = useState<ImmichAlbum | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [showOutputPanel, setShowOutputPanel] = useState(false);
  const [outputType, setOutputType] = useState<OutputType | null>(null);
  const [letAiChoose, setLetAiChoose] = useState(false);
  const [ranking, setRanking] = useState<{
    scores: Array<{ assetId: string; score: number; rank: number; reasons: string[] }>;
    topIds: string[];
    modelUsed: string;
    visionConfigured: boolean;
  } | null>(null);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [showRankingPanel, setShowRankingPanel] = useState(false);
  const [compositionScript, setCompositionScript] = useState<any>(null);
  const [compositionLoading, setCompositionLoading] = useState(false);
  const [showScriptPanel, setShowScriptPanel] = useState(false);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, "POSITIVE" | "NEGATIVE">>({});
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([
    { role: "assistant", content: "Hi! I'm your composition assistant. Ask me anything about creating great sports content!" },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchEventData = useCallback(async () => {
    try {
      const eventRes = await fetch(`/api/events/${id}`);
      if (!eventRes.ok) throw new Error("Failed to load event");
      const eventData = await eventRes.json();
      setEvent(eventData.event);

      if (eventData.event.immichAlbumId) {
        const albumRes = await fetch(`/api/immich/albums/${eventData.event.immichAlbumId}`);
        if (albumRes.ok) {
          const albumData = await albumRes.json();
          setAlbum(albumData.album);
        }
      }

      // Load existing feedback
      const fbRes = await fetch(`/api/feedback?eventId=${id}`);
      if (fbRes.ok) {
        const fbData = await fbRes.json();
        const map: Record<string, "POSITIVE" | "NEGATIVE"> = {};
        fbData.feedback.forEach((f: any) => {
          map[f.sourceAssetId] = f.rating;
        });
        setFeedbackMap(map);
      }
    } catch {
      setError("Failed to load event data");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchEventData();
  }, [fetchEventData]);

  const filteredAssets = album?.assets.filter((asset) => {
    if (filter === "all") return true;
    return asset.type.toLowerCase() === filter;
  }) || [];

  const toggleSelection = (assetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(filteredAssets.map((a) => a.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const isAllSelected = filteredAssets.length > 0 && filteredAssets.every((a) => selectedIds.has(a.id));

  const enterSelectionMode = () => {
    setSelectionMode(true);
    setSelectedIds(new Set());
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setShowOutputPanel(false);
    setOutputType(null);
    setLetAiChoose(false);
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append("files", files[i]);
      }
      const res = await fetch(`/api/events/${id}/upload`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Upload failed");
      } else if (data.errors && data.errors.length > 0) {
        alert(`Upload completed with ${data.errors.length} error(s):\n${data.errors.join("\n")}`);
      } else {
        alert(`Upload successful! ${data.uploaded} file(s) added.`);
        await fetchEventData();
      }
    } catch {
      alert("Upload error");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleUpload(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleCompose = async () => {
    if (selectedIds.size === 0 && !letAiChoose) return;

    setRankingLoading(true);
    setShowRankingPanel(true);

    try {
      const idsToRank = letAiChoose
        ? filteredAssets.map((a) => a.id)
        : Array.from(selectedIds);

      const res = await fetch("/api/ai/vision/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetIds: idsToRank,
          eventId: id,
        }),
      });

      const data = await res.json();

      if (data.success) {
        setRanking(data);
        // Pre-select top-ranked assets
        if (data.topIds?.length > 0) {
          setSelectedIds(new Set(data.topIds));
        }
      } else {
        setRanking({
          scores: [],
          topIds: idsToRank.slice(0, 10),
          modelUsed: "error-fallback",
          visionConfigured: false,
        });
      }
    } catch {
      setRanking({
        scores: [],
        topIds: Array.from(selectedIds).slice(0, 10),
        modelUsed: "error-fallback",
        visionConfigured: false,
      });
    } finally {
      setRankingLoading(false);
    }
  };

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
    <div className="min-h-screen bg-zinc-50 pb-28" onDrop={handleDrop} onDragOver={handleDragOver}>
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-6xl mx-auto">
          <Link
            href="/dashboard"
            className="text-sm text-zinc-500 hover:text-zinc-900 mb-2 inline-block"
          >
            &larr; Back to Events
          </Link>
          <h1 className="text-2xl font-bold text-zinc-900">{event.name}</h1>
          <div className="flex items-center gap-3 mt-2 text-sm text-zinc-600">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 font-medium">
              {event.sport}
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
              {event.city}
            </span>
            <span>
              {new Date(event.eventDate).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
          {event.description && (
            <p className="text-zinc-600 mt-2">{event.description}</p>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-6 py-6">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div className="text-sm text-zinc-600">
            {album ? (
              <span>
                <strong className="text-zinc-900">{album.assetCount}</strong> assets in Immich
                {album.assetCount !== filteredAssets.length && (
                  <span> &middot; <strong className="text-zinc-900">{filteredAssets.length}</strong> filtered</span>
                )}
              </span>
            ) : (
              <span className="text-zinc-400">No Immich album linked</span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Filter */}
            <span className="text-sm text-zinc-500 mr-1">Filter:</span>
            {(["all", "image", "video"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  filter === f
                    ? "bg-[var(--accent)] text-white"
                    : "bg-white text-zinc-600 border border-zinc-200 hover:bg-zinc-50"
                }`}
              >
                {f === "all" ? "All" : f === "image" ? "Photos" : "Videos"}
              </button>
            ))}

            <div className="w-px h-6 bg-zinc-200 mx-2 hidden sm:block" />

            {/* Upload */}
            {!selectionMode && (
              <>
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
                  className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 disabled:opacity-40"
                >
                  {uploading ? "Uploading..." : "+ Upload"}
                </button>
                <div className="w-px h-6 bg-zinc-200 mx-2 hidden sm:block" />
              </>
            )}

            {/* Selection mode toggle */}
            {!selectionMode ? (
              <button
                onClick={enterSelectionMode}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50"
              >
                Select Media
              </button>
            ) : (
              <button
                onClick={exitSelectionMode}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-zinc-100 text-zinc-700 border border-zinc-200 hover:bg-zinc-200"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Selection controls bar */}
        {selectionMode && (
          <div className="flex items-center justify-between mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
            <div className="flex items-center gap-3">
              <button
                onClick={isAllSelected ? deselectAll : selectAll}
                className="text-sm font-medium text-blue-700 hover:text-blue-800"
              >
                {isAllSelected ? "Deselect All" : "Select All"}
              </button>
              <span className="text-sm text-zinc-600">
                <strong className="text-zinc-900">{selectedIds.size}</strong> selected
              </span>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-zinc-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={letAiChoose}
                  onChange={(e) => {
                    setLetAiChoose(e.target.checked);
                    if (e.target.checked) {
                      setSelectedIds(new Set(filteredAssets.map((a) => a.id)));
                    }
                  }}
                  className="rounded border-zinc-300 text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                Let AI choose the best
              </label>
              <button
                onClick={handleCompose}
                disabled={selectedIds.size === 0}
                className="px-4 py-1.5 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Compose &rarr;
              </button>
            </div>
          </div>
        )}

        {/* Media Grid */}
        {album && album.assets.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filteredAssets.map((asset) => (
              <MediaCard
                key={asset.id}
                asset={asset}
                selectionMode={selectionMode}
                selected={selectedIds.has(asset.id)}
                onToggle={() => toggleSelection(asset.id)}
                onFeedback={(rating) => {
                  fetch("/api/feedback", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      eventId: id,
                      sourceAssetId: asset.id,
                      rating,
                    }),
                  });
                  setFeedbackMap((prev) => ({ ...prev, [asset.id]: rating }));
                }}
                feedback={feedbackMap[asset.id] || null}
              />
            ))}
          </div>
        ) : album ? (
          <div className="bg-white rounded-lg border border-zinc-200 p-12 text-center">
            <p className="text-zinc-500">
              {filter !== "all"
                ? `No ${filter === "image" ? "photos" : "videos"} found.`
                : "This album is empty. Upload media via the Immich app."}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-zinc-200 p-12 text-center">
            <p className="text-zinc-500 mb-2">No Immich album linked to this event.</p>
            <p className="text-sm text-zinc-400">
              Create an event with an Immich album to browse media here.
            </p>
          </div>
        )}
      </main>

      {/* AI Ranking Results Panel */}
      {showRankingPanel && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowRankingPanel(false)}
          />
          <div className="relative bg-white rounded-t-xl sm:rounded-xl shadow-xl w-full sm:max-w-lg max-h-[80vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-900">AI Media Ranking</h2>
              {rankingLoading && (
                <span className="text-sm text-zinc-500 animate-pulse">Analyzing...</span>
              )}
            </div>

            {rankingLoading && !ranking && (
              <div className="text-center py-8">
                <div className="w-8 h-8 border-2 border-zinc-200 border-t-[var(--accent)] rounded-full animate-spin mx-auto mb-3" />
                <p className="text-sm text-zinc-500">AI is analyzing your media...</p>
                <p className="text-xs text-zinc-400 mt-1">Evaluating composition, action, faces, lighting, and emotion</p>
              </div>
            )}

            {!rankingLoading && ranking && (
              <>
                {!ranking.visionConfigured && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                    <p className="text-sm text-amber-800">
                      Vision AI not configured. Using default ranking.
                      Set VISION_API_URL and VISION_API_KEY in .env to enable AI analysis.
                    </p>
                  </div>
                )}

                {ranking.scores.length > 0 && (
                  <div className="space-y-3 mb-6">
                    {ranking.scores.map((score) => (
                      <div
                        key={score.assetId}
                        className={`flex items-start gap-3 p-3 rounded-lg border ${
                          score.rank <= 3
                            ? "border-[var(--accent)] bg-blue-50"
                            : "border-zinc-200 bg-white"
                        }`}
                      >
                        <div
                          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                            score.rank === 1
                              ? "bg-yellow-400 text-yellow-900"
                              : score.rank === 2
                              ? "bg-zinc-300 text-zinc-700"
                              : score.rank === 3
                              ? "bg-amber-600 text-white"
                              : "bg-zinc-100 text-zinc-500"
                          }`}
                        >
                          {score.rank}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-zinc-900 text-sm">
                              Score: {score.score}/100
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {score.reasons.map((r, i) => (
                              <span
                                key={i}
                                className="text-xs px-2 py-0.5 bg-zinc-100 text-zinc-600 rounded-full"
                              >
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowRankingPanel(false)}
                    className="flex-1 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => {
                      setShowRankingPanel(false);
                      setShowOutputPanel(true);
                    }}
                    className="flex-1 px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)]"
                  >
                    Continue to Output &rarr;
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Output Type Selection Panel */}
      {showOutputPanel && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowOutputPanel(false)}
          />
          <div className="relative bg-white rounded-t-xl sm:rounded-xl shadow-xl w-full sm:max-w-lg p-6">
            <h2 className="text-lg font-semibold text-zinc-900 mb-1">Choose Output Type</h2>
            <p className="text-sm text-zinc-500 mb-5">
              {selectedIds.size} asset{selectedIds.size !== 1 ? "s" : ""} selected
              {letAiChoose && " — AI will rank and select the best"}
            </p>

            <div className="space-y-3 mb-6">
              <OutputOption
                title="Collage Poster"
                description="Grid layout of best photos with branded captions"
                icon="🖼️"
                selected={outputType === "collage"}
                onClick={() => setOutputType("collage")}
              />
              <OutputOption
                title="15s Highlight Video"
                description="Quick cuts with transitions and captions"
                icon="🎬"
                selected={outputType === "highlight"}
                onClick={() => setOutputType("highlight")}
              />
              <OutputOption
                title="Full Wrap-up Video"
                description="Extended edit with all selected media"
                icon="🎞️"
                selected={outputType === "wrapup"}
                onClick={() => setOutputType("wrapup")}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowOutputPanel(false)}
                className="flex-1 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                disabled={!outputType}
                onClick={async () => {
                  setCompositionLoading(true);
                  setShowOutputPanel(false);
                  setShowScriptPanel(true);

                  const selectedAssets = filteredAssets.filter((a) => selectedIds.has(a.id));

                  try {
                    const res = await fetch("/api/ai/composition", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        event: {
                          name: event?.name,
                          sport: event?.sport,
                          city: event?.city,
                          eventDate: event?.eventDate,
                          description: event?.description,
                        },
                        assets: selectedAssets.map((a) => ({
                          assetId: a.id,
                          fileName: a.originalFileName,
                          type: a.type === "VIDEO" ? "VIDEO" : "IMAGE",
                          aiScore: ranking?.scores?.find((s) => s.assetId === a.id)?.score,
                          aiReasons: ranking?.scores?.find((s) => s.assetId === a.id)?.reasons,
                        })),
                        outputType,
                      }),
                    });

                    const data = await res.json();
                    if (data.success) {
                      setCompositionScript(data.script);
                    } else {
                      setCompositionScript({ type: "error", message: data.error });
                    }
                  } catch {
                    setCompositionScript({ type: "error", message: "Failed to generate composition" });
                  } finally {
                    setCompositionLoading(false);
                  }
                }}
                className="flex-1 px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {compositionLoading ? "Generating..." : "Start Composition"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Composition Script Review Panel */}
      {showScriptPanel && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowScriptPanel(false)}
          />
          <div className="relative bg-white rounded-t-xl sm:rounded-xl shadow-xl w-full sm:max-w-2xl max-h-[85vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-900">Composition Script</h2>
              {compositionLoading && (
                <span className="text-sm text-zinc-500 animate-pulse">Generating...</span>
              )}
            </div>

            {compositionLoading && !compositionScript && (
              <div className="text-center py-8">
                <div className="w-8 h-8 border-2 border-zinc-200 border-t-[var(--accent)] rounded-full animate-spin mx-auto mb-3" />
                <p className="text-sm text-zinc-500">AI is planning your composition...</p>
                <p className="text-xs text-zinc-400 mt-1">Layout, order, captions, and transitions</p>
              </div>
            )}

            {!compositionLoading && compositionScript?.type === "error" && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                <p className="text-sm text-red-700 font-medium">Error</p>
                <p className="text-sm text-red-600 mt-1">{compositionScript.message}</p>
              </div>
            )}

            {!compositionLoading && compositionScript && compositionScript.type !== "error" && (
              <>
                <div className="bg-zinc-50 rounded-lg border border-zinc-200 p-4 mb-4">
                  <h3 className="font-semibold text-zinc-900 mb-2">
                    {compositionScript.title || "Untitled Composition"}
                  </h3>
                  <p className="text-sm text-zinc-600 mb-3">
                    {compositionScript.subtitle || ""}
                  </p>

                  {compositionScript.type === "collage" ? (
                    <div className="space-y-2">
                      <p className="text-sm">
                        <strong className="text-zinc-700">Layout:</strong>{" "}
                        {compositionScript.layout || "grid"} ({compositionScript.gridCols}x{compositionScript.gridRows})
                      </p>
                      <p className="text-sm">
                        <strong className="text-zinc-700">Dimensions:</strong>{" "}
                        {compositionScript.dimensions?.width}x{compositionScript.dimensions?.height}px
                      </p>
                      <p className="text-sm">
                        <strong className="text-zinc-700">Images:</strong>{" "}
                        {compositionScript.images?.length || 0} placed
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm">
                        <strong className="text-zinc-700">Total Duration:</strong>{" "}
                        {compositionScript.totalDuration}s
                      </p>
                      <p className="text-sm">
                        <strong className="text-zinc-700">Clips:</strong>{" "}
                        {compositionScript.clips?.length || 0}
                      </p>
                      <p className="text-sm">
                        <strong className="text-zinc-700">Music Tempo:</strong>{" "}
                        {compositionScript.musicTempo || "none"}
                      </p>
                      <p className="text-sm">
                        <strong className="text-zinc-700">Resolution:</strong>{" "}
                        {compositionScript.resolution || "1080p"}
                      </p>
                    </div>
                  )}
                </div>

                <div className="bg-zinc-50 rounded-lg border border-zinc-200 p-4 mb-4 overflow-x-auto">
                  <p className="text-xs font-medium text-zinc-500 mb-2 uppercase tracking-wide">
                    Raw Script JSON
                  </p>
                  <pre className="text-xs text-zinc-700 whitespace-pre-wrap">
                    {JSON.stringify(compositionScript, null, 2)}
                  </pre>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowScriptPanel(false)}
                    className="flex-1 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50"
                  >
                    Close
                  </button>
                  <button
                    disabled={compositionLoading}
                    onClick={async () => {
                      setCompositionLoading(true);
                      try {
                        const res = await fetch("/api/composition/execute", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            script: compositionScript,
                            eventId: id,
                          }),
                        });
                        const data = await res.json();
                        if (data.success) {
                          alert(`Composition complete!\nFile: ${data.fileName}\nSize: ${(data.fileSize / 1024 / 1024).toFixed(2)} MB`);
                          setShowScriptPanel(false);
                        } else {
                          alert(`Error: ${data.error}`);
                        }
                      } catch {
                        alert("Failed to execute composition");
                      } finally {
                        setCompositionLoading(false);
                      }
                    }}
                    className="flex-1 px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {compositionLoading ? "Processing..." : "Execute Composition"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* AI Assistant Chat Panel */}
      {chatOpen && (
        <div className="fixed bottom-4 right-4 w-80 sm:w-96 bg-white rounded-xl border border-zinc-200 shadow-2xl z-50 flex flex-col overflow-hidden" style={{ maxHeight: "500px" }}>
          {/* Chat header */}
          <div className="px-4 py-3 bg-[var(--accent)] text-white flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-lg">🤖</span>
              <span className="font-medium text-sm">Composition Assistant</span>
            </div>
            <button onClick={() => setChatOpen(false)} className="text-white/80 hover:text-white text-sm">
              Close
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
            {chatMessages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] text-sm rounded-lg px-3 py-2 ${
                    msg.role === "user"
                      ? "bg-[var(--accent)] text-white rounded-br-none"
                      : "bg-zinc-100 text-zinc-800 rounded-bl-none"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-zinc-100 rounded-lg rounded-bl-none px-3 py-2">
                  <span className="text-sm text-zinc-500">Thinking...</span>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="p-3 border-t border-zinc-200 flex-shrink-0">
            <div className="flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && chatInput.trim()) {
                    const text = chatInput.trim();
                    setChatInput("");
                    setChatMessages((prev) => [...prev, { role: "user", content: text }]);
                    setChatLoading(true);
                    fetch("/api/chat", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        message: text,
                        history: chatMessages,
                        context: {
                          eventName: event?.name || "",
                          sport: event?.sport || "",
                          city: event?.city || "",
                          eventDate: event?.eventDate || "",
                          selectedCount: selectedIds.size,
                          outputType: outputType || undefined,
                        },
                      }),
                    })
                      .then((r) => r.json())
                      .then((data) => {
                        if (data.success) {
                          setChatMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
                        } else {
                          setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
                        }
                      })
                      .catch(() => {
                        setChatMessages((prev) => [...prev, { role: "assistant", content: "Failed to get response. Please try again." }]);
                      })
                      .finally(() => setChatLoading(false));
                  }
                }}
                placeholder="Ask about composition..."
                className="flex-1 text-sm px-3 py-2 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent"
              />
              <button
                onClick={() => {
                  const text = chatInput.trim();
                  if (!text) return;
                  setChatInput("");
                  setChatMessages((prev) => [...prev, { role: "user", content: text }]);
                  setChatLoading(true);
                  fetch("/api/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      message: text,
                      history: chatMessages,
                      context: {
                        eventName: event?.name || "",
                        sport: event?.sport || "",
                        city: event?.city || "",
                        eventDate: event?.eventDate || "",
                        selectedCount: selectedIds.size,
                        outputType: outputType || undefined,
                      },
                    }),
                  })
                    .then((r) => r.json())
                    .then((data) => {
                      if (data.success) {
                        setChatMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
                      } else {
                        setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
                      }
                    })
                    .catch(() => {
                      setChatMessages((prev) => [...prev, { role: "assistant", content: "Failed to get response. Please try again." }]);
                    })
                    .finally(() => setChatLoading(false));
                }}
                disabled={chatLoading || !chatInput.trim()}
                className="px-3 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat toggle button */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 bg-[var(--accent)] text-white rounded-full shadow-lg hover:bg-[var(--accent-hover)] flex items-center justify-center z-40"
          title="Composition Assistant"
        >
          <span className="text-2xl">🤖</span>
        </button>
      )}
    </div>
  );
}

function MediaCard({
  asset,
  selectionMode,
  selected,
  onToggle,
  onFeedback,
  feedback,
}: {
  asset: ImmichAsset;
  selectionMode: boolean;
  selected: boolean;
  onToggle: () => void;
  onFeedback?: (rating: "POSITIVE" | "NEGATIVE") => void;
  feedback?: "POSITIVE" | "NEGATIVE" | null;
}) {
  const [loaded, setLoaded] = useState(false);
  const isVideo = asset.type === "VIDEO";

  return (
    <div
      onClick={() => selectionMode && onToggle()}
      className={`group relative bg-white rounded-lg border overflow-hidden hover:shadow-md transition-shadow ${
        selected ? "border-[var(--accent)] ring-2 ring-[var(--accent)]" : "border-zinc-200"
      } ${selectionMode ? "cursor-pointer" : ""}`}
    >
      {/* Selection checkbox */}
      {selectionMode && (
        <div className="absolute top-2 left-2 z-10">
          <div
            className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
              selected
                ? "bg-[var(--accent)] border-[var(--accent)]"
                : "bg-white/90 border-zinc-300"
            }`}
          >
            {selected && (
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Feedback buttons (visible on hover when not selecting) */}
      {!selectionMode && onFeedback && (
        <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onFeedback("POSITIVE"); }}
            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm ${
              feedback === "POSITIVE"
                ? "bg-green-500 text-white"
                : "bg-white/90 text-zinc-500 hover:text-green-600"
            } shadow-sm`}
            title="Good example"
          >
            👍
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onFeedback("NEGATIVE"); }}
            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm ${
              feedback === "NEGATIVE"
                ? "bg-red-500 text-white"
                : "bg-white/90 text-zinc-500 hover:text-red-600"
            } shadow-sm`}
            title="Needs work"
          >
            👎
          </button>
        </div>
      )}

      <div className="aspect-square relative bg-zinc-100">
        {isVideo ? (
          <>
            <div className="absolute inset-0 flex items-center justify-center">
              <svg className="w-12 h-12 text-zinc-300" fill="currentColor" viewBox="0 0 24 24">
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
            onLoad={() => setLoaded(true)}
            className={`w-full h-full object-cover transition-opacity duration-300 ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
      </div>
      <div className="p-2">
        <p className="text-xs text-zinc-500 truncate" title={asset.originalFileName}>
          {asset.originalFileName}
        </p>
        <p className="text-xs text-zinc-400 mt-0.5">
          {new Date(asset.fileCreatedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </p>
      </div>
    </div>
  );
}

function OutputOption({
  title,
  description,
  icon,
  selected,
  onClick,
}: {
  title: string;
  description: string;
  icon: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
        selected
          ? "border-[var(--accent)] bg-blue-50"
          : "border-zinc-200 hover:border-zinc-300"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl">{icon}</span>
        <div>
          <h3 className="font-semibold text-zinc-900">{title}</h3>
          <p className="text-sm text-zinc-500 mt-0.5">{description}</p>
        </div>
      </div>
    </button>
  );
}
