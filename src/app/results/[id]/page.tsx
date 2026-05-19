"use client";

import { useEffect, useState, useCallback } from "react";
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
  const [musicModels, setMusicModels] = useState<any[]>([]);
  const [selectedMusicModel, setSelectedMusicModel] = useState("minimax-music-v2");
  const [musicTempo, setMusicTempo] = useState<"upbeat" | "calm" | "dramatic">("upbeat");
  const [musicPrompt, setMusicPrompt] = useState("");
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicStatus, setMusicStatus] = useState("");
  const [generatedMusicPath, setGeneratedMusicPath] = useState("");
  const [mixingMusic, setMixingMusic] = useState(false);
  const [musicIntent, setMusicIntent] = useState("");
  const [showMusicIntent, setShowMusicIntent] = useState(true);

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

  // Load music models on mount
  useEffect(() => {
    fetch("/api/music/generate", { method: "GET" })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setMusicModels(data.models);
      })
      .catch(() => {});
  }, []);

  // Auto-generate music prompt when asset loads or intent changes
  const generateMusicPrompt = useCallback(async (intent?: string) => {
    if (!asset || !isVideo) return;
    const type = asset.outputType === "HIGHLIGHT_VIDEO_15S" ? "highlight" : "wrapup";
    try {
      const res = await fetch("/api/music/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventName: asset.event.name,
          sport: asset.event.sport,
          compositionType: type,
          targetTempo: musicTempo,
          userIntent: intent,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMusicPrompt(data.prompt);
        setShowMusicIntent(false);
      }
    } catch {
      // ignore
    }
  }, [asset, musicTempo, isVideo]);

  useEffect(() => {
    if (asset && isVideo && !musicPrompt) {
      generateMusicPrompt();
    }
  }, [asset, isVideo, musicPrompt, generateMusicPrompt]);

  const handleGenerateMusic = async () => {
    setMusicLoading(true);
    setMusicStatus("Queuing music generation...");
    setGeneratedMusicPath("");
    try {
      const res = await fetch("/api/music/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedMusicModel,
          prompt: musicPrompt,
          durationSeconds: isVideo ? undefined : 60,
          forceInstrumental: true,
        }),
      });
      const data = await res.json();
      if (data.success && data.filePath) {
        setGeneratedMusicPath(data.filePath);
        setMusicStatus(`Generated! (${data.model}, $${getModelPrice()})`);
      } else {
        setMusicStatus(`Failed: ${data.error || "Unknown error"}`);
      }
    } catch (err: any) {
      setMusicStatus(`Error: ${err.message || "Music generation failed"}`);
    } finally {
      setMusicLoading(false);
    }
  };

  const handleMixMusic = async () => {
    if (!generatedMusicPath) return;
    setMixingMusic(true);
    setMusicStatus("Mixing music into video...");
    try {
      const res = await fetch(`/api/results/${id}/music`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ musicFilePath: generatedMusicPath }),
      });
      const data = await res.json();
      if (data.success) {
        setMusicStatus("Background music added to video! Refresh to preview.");
        // Force video reload by appending timestamp
        setTimeout(() => window.location.reload(), 500);
      } else {
        setMusicStatus(`Mix failed: ${data.error}`);
      }
    } catch (err: any) {
      setMusicStatus(`Mix error: ${err.message || "Failed"}`);
    } finally {
      setMixingMusic(false);
    }
  };

  const getModelPrice = () => {
    const model = musicModels.find((m) => m.id === selectedMusicModel);
    return model ? `$${model.pricingUsd}` : "?";
  };

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
                <div className="mx-auto" style={{ maxWidth: "360px" }}>
                  <video
                    controls
                    className="w-full rounded-lg shadow-sm"
                    style={{ aspectRatio: "9/16" }}
                  >
                    <source src={`/api/results/${id}/download`} type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                </div>
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

            {/* Music Generation (video only) */}
            {isVideo && (
              <div className="bg-white rounded-lg border border-zinc-200 p-6">
                <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                  Background Music
                </h2>

                <div className="space-y-4">
                  {/* Step 1: Intent */}
                  {showMusicIntent && (
                    <div className="bg-zinc-50 rounded-lg border border-zinc-200 p-4">
                      <label className="block text-sm font-medium text-zinc-700 mb-2">
                        Describe the music you want
                        <span className="text-zinc-400 font-normal ml-1">(optional — AI will suggest a prompt)</span>
                      </label>
                      <textarea
                        value={musicIntent}
                        onChange={(e) => setMusicIntent(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent resize-y"
                        placeholder={`Examples:\n• "Upbeat electronic pop with driving drums"\n• "Inspiring cinematic orchestral, building to a climax"\n• "Chill lo-fi hip hop, no vocals"`}
                      />
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => generateMusicPrompt(musicIntent.trim() || undefined)}
                          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)]"
                        >
                          Generate Music Prompt
                        </button>
                        <button
                          onClick={() => {
                            setShowMusicIntent(false);
                          }}
                          className="px-4 py-2 border border-zinc-200 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50"
                        >
                          Skip — Use Default
                        </button>
                      </div>
                    </div>
                  )}

                  {!showMusicIntent && (
                    <>
                      {/* Tempo selection */}
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-2">
                          Mood / Tempo
                        </label>
                        <div className="flex gap-2">
                          {(["upbeat", "calm", "dramatic"] as const).map((t) => (
                            <button
                              key={t}
                              onClick={() => setMusicTempo(t)}
                              className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                                musicTempo === t
                                  ? "bg-[var(--accent)] text-white"
                                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Model selection */}
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 mb-2">
                          AI Music Model
                        </label>
                        <select
                          value={selectedMusicModel}
                          onChange={(e) => setSelectedMusicModel(e.target.value)}
                          className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent"
                        >
                          {musicModels.length === 0 && (
                            <option value="minimax-music-v2">minimax-music-v2 ($0.04)</option>
                          )}
                          {musicModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} — ${m.pricingUsd}{m.supportsInstrumental ? ", instrumental" : ", with vocals"}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Prompt editor */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="block text-sm font-medium text-zinc-700">
                            Music Prompt
                          </label>
                          <button
                            onClick={() => {
                              setShowMusicIntent(true);
                              setMusicIntent("");
                            }}
                            className="text-xs text-[var(--accent)] hover:underline"
                          >
                            Refine from intent
                          </button>
                        </div>
                        <textarea
                          value={musicPrompt}
                          onChange={(e) => setMusicPrompt(e.target.value)}
                          rows={4}
                          className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent resize-y"
                          placeholder="Describe the background music you want..."
                        />
                      </div>

                      {/* Generate button */}
                      <div className="flex flex-wrap gap-3 items-center">
                        <button
                          onClick={handleGenerateMusic}
                          disabled={musicLoading || !musicPrompt.trim()}
                          className="px-4 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {musicLoading ? "Generating..." : `Generate Music (${getModelPrice()})`}
                        </button>

                        {generatedMusicPath && (
                          <button
                            onClick={handleMixMusic}
                            disabled={mixingMusic}
                            className="px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {mixingMusic ? "Mixing..." : "Add to Video"}
                          </button>
                        )}
                      </div>

                      {musicStatus && (
                        <p
                          className={`text-sm ${
                            musicStatus.includes("Failed") || musicStatus.includes("failed")
                              ? "text-red-600"
                              : musicStatus.includes("Mix")
                              ? "text-amber-600"
                              : "text-green-600"
                          }`}
                        >
                          {musicStatus}
                        </p>
                      )}

                      {/* Preview generated music */}
                      {generatedMusicPath && !musicLoading && (
                        <div className="mt-3">
                          <p className="text-sm text-zinc-600 mb-2">Preview:</p>
                          <audio
                            controls
                            className="w-full"
                            src={`/api/music/download?path=${encodeURIComponent(generatedMusicPath)}`}
                          >
                            Your browser does not support the audio tag.
                          </audio>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
