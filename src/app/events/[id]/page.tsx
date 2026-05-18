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

export default function EventPage() {
  const { id } = useParams();
  const [event, setEvent] = useState<EventData | null>(null);
  const [album, setAlbum] = useState<ImmichAlbum | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");

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
    <div className="min-h-screen bg-zinc-50">
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
        {/* Stats + Filters */}
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

          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-500">Filter:</span>
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
          </div>
        </div>

        {/* Media Grid */}
        {album && album.assets.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filteredAssets.map((asset) => (
              <MediaCard key={asset.id} asset={asset} />
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
    </div>
  );
}

function MediaCard({ asset }: { asset: ImmichAsset }) {
  const [loaded, setLoaded] = useState(false);
  const isVideo = asset.type === "VIDEO";

  return (
    <div className="group relative bg-white rounded-lg border border-zinc-200 overflow-hidden hover:shadow-md transition-shadow">
      <div className="aspect-square relative bg-zinc-100">
        {isVideo ? (
          <>
            <div className="absolute inset-0 flex items-center justify-center">
              <svg
                className="w-12 h-12 text-zinc-300"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
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
