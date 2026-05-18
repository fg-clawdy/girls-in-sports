"use client";

import { useEffect, useState, useCallback } from "react";
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

  const handleCompose = () => {
    if (selectedIds.size === 0 && !letAiChoose) return;
    setShowOutputPanel(true);
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
    <div className="min-h-screen bg-zinc-50 pb-28">
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
                onClick={() => {
                  alert(`Starting ${outputType} with ${selectedIds.size} assets... (AI composition coming in US-006/007)`);
                }}
                className="flex-1 px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Start Composition
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MediaCard({
  asset,
  selectionMode,
  selected,
  onToggle,
}: {
  asset: ImmichAsset;
  selectionMode: boolean;
  selected: boolean;
  onToggle: () => void;
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
