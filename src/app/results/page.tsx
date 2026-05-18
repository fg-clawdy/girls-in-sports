"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface GeneratedAsset {
  id: string;
  outputType: string;
  fileName: string;
  fileSize: number;
  status: string;
  createdAt: string;
  event: {
    id: string;
    name: string;
    sport: string;
    city: string;
    eventDate: string;
  };
}

export default function ResultsCatalogPage() {
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/results")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setAssets(data.assets);
      })
      .finally(() => setLoading(false));
  }, []);

  const formatDate = (d: string) => new Date(d).toLocaleDateString();
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getTypeLabel = (type: string) => {
    if (type === "COLLAGE_POSTER") return "Collage Poster";
    if (type === "HIGHLIGHT_VIDEO_15S") return "15s Highlight";
    return "Wrap-up Video";
  };

  const getTypeIcon = (type: string) => {
    if (type === "COLLAGE_POSTER") return "🖼️";
    return "🎬";
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-zinc-500 hover:text-zinc-900">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </Link>
            <h1 className="text-xl font-bold text-zinc-900">Results Catalog</h1>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto p-6">
        {loading ? (
          <p className="text-zinc-500">Loading results...</p>
        ) : assets.length === 0 ? (
          <div className="bg-white rounded-lg border border-zinc-200 p-12 text-center">
            <p className="text-zinc-500">No compositions yet.</p>
            <p className="text-sm text-zinc-400 mt-1">
              Create your first composition from an event page.
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            {assets.map((asset) => (
              <Link
                key={asset.id}
                href={`/results/${asset.id}`}
                className="bg-white rounded-lg border border-zinc-200 p-5 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-zinc-100 flex items-center justify-center text-2xl flex-shrink-0">
                      {getTypeIcon(asset.outputType)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-zinc-900">
                          {getTypeLabel(asset.outputType)}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            asset.status === "COMPLETED"
                              ? "bg-green-100 text-green-700"
                              : asset.status === "IN_PROGRESS"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {asset.status}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-600">{asset.fileName}</p>
                      <p className="text-xs text-zinc-400 mt-1">
                        {asset.event?.name} • {asset.event?.sport} • {asset.event?.city}
                      </p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm text-zinc-500">{formatSize(asset.fileSize)}</p>
                    <p className="text-xs text-zinc-400">{formatDate(asset.createdAt)}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
