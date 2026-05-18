"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface GeneratedAssetDetail {
  id: string;
  outputType: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  status: string;
  createdAt: string;
  immichAssetId: string | null;
  event: {
    id: string;
    name: string;
    sport: string;
    city: string;
    eventDate: string;
    immichAlbumId: string | null;
  };
}

export default function ResultDetailPage() {
  const { id } = useParams();
  const [asset, setAsset] = useState<GeneratedAssetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");

  useEffect(() => {
    fetch(`/api/results/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setAsset(data.asset);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const formatDate = (d: string) => new Date(d).toLocaleDateString();
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const handleUpload = async () => {
    setUploading(true);
    setUploadMessage("");
    try {
      const res = await fetch(`/api/results/${id}/upload`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setUploadMessage("Uploaded to Immich successfully!");
        setAsset((prev) => prev ? { ...prev, immichAssetId: data.immichAssetId } : prev);
      } else {
        setUploadMessage(`Upload failed: ${data.error}`);
      }
    } catch {
      setUploadMessage("Upload failed. Check server logs.");
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = () => {
    if (!asset?.filePath) return;
    // Open file path in a new window (served via static file route or direct path)
    window.open(`/api/results/${id}/download`, "_blank");
  };

  const isImage = asset?.outputType === "COLLAGE_POSTER";
  const isVideo = asset?.outputType === "WRAP_UP_VIDEO" || asset?.outputType === "HIGHLIGHT_VIDEO_15S";

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/results" className="text-zinc-500 hover:text-zinc-900">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </Link>
            <h1 className="text-xl font-bold text-zinc-900">Result Detail</h1>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-6">
        {loading ? (
          <p className="text-zinc-500">Loading...</p>
        ) : !asset ? (
          <p className="text-red-600">Result not found</p>
        ) : (
          <div className="space-y-6">
            {/* Preview */}
            <div className="bg-white rounded-lg border border-zinc-200 p-6">
              <h2 className="text-lg font-semibold text-zinc-900 mb-4">Preview</h2>
              {asset.status !== "COMPLETED" ? (
                <p className="text-zinc-500">This composition is still being processed.</p>
              ) : isImage ? (
                <img
                  src={`/api/results/${id}/download`}
                  alt={asset.fileName}
                  className="max-h-96 w-auto mx-auto rounded-lg shadow-sm"
                />
              ) : isVideo ? (
                <video
                  controls
                  className="w-full rounded-lg shadow-sm"
                  style={{ maxHeight: "24rem" }}
                >
                  <source src={`/api/results/${id}/download`} type="video/mp4" />
                  Your browser does not support the video tag.
                </video>
              ) : (
                <p className="text-zinc-500">Unknown output type</p>
              )}
            </div>

            {/* Details */}
            <div className="bg-white rounded-lg border border-zinc-200 p-6">
              <h2 className="text-lg font-semibold text-zinc-900 mb-4">Details</h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-zinc-500 mb-1">File Name</p>
                  <p className="text-zinc-900 font-medium">{asset.fileName}</p>
                </div>
                <div>
                  <p className="text-zinc-500 mb-1">Size</p>
                  <p className="text-zinc-900 font-medium">{formatSize(asset.fileSize)}</p>
                </div>
                <div>
                  <p className="text-zinc-500 mb-1">Type</p>
                  <p className="text-zinc-900 font-medium">
                    {asset.outputType === "COLLAGE_POSTER" ? "Collage Poster" : "Video"}
                  </p>
                </div>
                <div>
                  <p className="text-zinc-500 mb-1">Created</p>
                  <p className="text-zinc-900 font-medium">{formatDate(asset.createdAt)}</p>
                </div>
                <div>
                  <p className="text-zinc-500 mb-1">Event</p>
                  <p className="text-zinc-900 font-medium">{asset.event?.name}</p>
                </div>
                <div>
                  <p className="text-zinc-500 mb-1">Status</p>
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
              </div>
            </div>

            {/* Actions */}
            <div className="bg-white rounded-lg border border-zinc-200 p-6">
              <h2 className="text-lg font-semibold text-zinc-900 mb-4">Actions</h2>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleDownload}
                  disabled={asset.status !== "COMPLETED"}
                  className="px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Download File
                </button>

                {asset.immichAssetId ? (
                  <span className="px-4 py-2.5 bg-green-100 text-green-700 rounded-lg text-sm font-medium">
                    Uploaded to Immich
                  </span>
                ) : (
                  <button
                    onClick={handleUpload}
                    disabled={uploading || asset.status !== "COMPLETED"}
                    className="px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {uploading ? "Uploading..." : "Upload to Immich"}
                  </button>
                )}
              </div>

              {uploadMessage && (
                <p
                  className={`text-sm mt-3 ${
                    uploadMessage.includes("failed") || uploadMessage.includes("Failed")
                      ? "text-red-600"
                      : "text-green-600"
                  }`}
                >
                  {uploadMessage}
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
