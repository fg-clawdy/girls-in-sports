"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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

interface EventItem {
  id: string;
  name: string;
  sport: string;
  status: string;
  createdAt: string;
  activityTags?: string[];
}

interface CampaignItem {
  id: string;
  eventId: string;
  name: string;
  status: string;
  createdAt: string;
}

const POLL_INTERVAL = 5000;

const JOB_TYPE_LABELS: Record<string, string> = {
  INGEST_CLIP: "Scene Detection",
  SCORE_CLIP: "AI Scoring",
  DIRECT_SCRIPT: "Script Generation",
  GENERATE_MUSIC: "Music Generation",
  RENDER_PROXY: "Proxy Render",
  RENDER_FINAL: "Final Render",
};

const STAGE_ORDER = ["UPLOADING", "INGESTING", "READY", "DIRECTING", "SCRIPTED", "PROXY_READY", "APPROVED", "RENDERING", "DONE"];

function getStageIndex(status: string): number {
  return STAGE_ORDER.indexOf(status);
}

function getPipelineStages(eventStatus: string, campaign?: CampaignItem) {
  const stages: { label: string; status: "pending" | "active" | "complete"; url?: string }[] = [
    { label: "Upload", status: eventStatus === "UPLOADING" ? "active" : getStageIndex(eventStatus) > getStageIndex("UPLOADING") ? "complete" : "pending" },
    { label: "Ingest", status: eventStatus === "INGESTING" ? "active" : getStageIndex(eventStatus) > getStageIndex("INGESTING") ? "complete" : "pending" },
    { label: "Curate", status: eventStatus === "READY" ? "active" : getStageIndex(eventStatus) > getStageIndex("READY") ? "complete" : "pending" },
  ];

  if (campaign) {
    stages.push(
      { label: "Direct", status: campaign.status === "DIRECTING" ? "active" : getStageIndex(campaign.status) > getStageIndex("DIRECTING") ? "complete" : "pending" },
      { label: "Draft", status: campaign.status === "PROXY_READY" ? "active" : getStageIndex(campaign.status) > getStageIndex("PROXY_READY") ? "complete" : "pending", url: `/campaigns/${campaign.id}/preview` },
      { label: "Final", status: campaign.status === "DONE" ? "complete" : campaign.status === "RENDERING" ? "active" : "pending", url: campaign.status === "DONE" ? `/campaigns/${campaign.id}/download` : undefined },
    );
  }

  return stages;
}

export default function DashboardPage() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [workerHealthy, setWorkerHealthy] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);

  const router = useRouter();

  // Create Event modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", sport: "", city: "", eventDate: "", description: "", activityTags: ["sports"] });
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");

  // Edit Event modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editEvent, setEditEvent] = useState<EventItem | null>(null);
  const [editForm, setEditForm] = useState({ name: "", sport: "", city: "", eventDate: "", description: "", activityTags: [] as string[] });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");

  const hasActiveJobs = jobs.some(
    (j) => j.status === "QUEUED" || j.status === "RUNNING" || j.status === "RETRYING"
  );

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs/status", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load dashboard");
      const data = await res.json();
      setJobs(data.jobs || []);
      setEvents(data.events || []);
      setCampaigns(data.campaigns || []);
      setWorkerHealthy(data.workerHealthy ?? false);
      setError("");
    } catch {
      setError("Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(() => {
      fetchDashboard();
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  const handleRetry = async (jobId: string) => {
    setRetryingJobId(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      await fetchDashboard();
    } catch {
      setError("Failed to retry job");
    } finally {
      setRetryingJobId(null);
    }
  };

  // ── Create Event ──────────────────────────────────────
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createForm.activityTags.length === 0) {
      setCreateError("Please select at least one activity type");
      return;
    }
    setCreateLoading(true);
    setCreateError("");
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create event");
      const newEventId = data.event.id;
      setShowCreateModal(false);
      setCreateForm({ name: "", sport: "", city: "", eventDate: "", description: "", activityTags: ["sports"] });
      router.push(`/events/${newEventId}`);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreateLoading(false);
    }
  };

  // ── Edit Event ──────────────────────────────────────
  const openEdit = (event: EventItem) => {
    setEditEvent(event);
    setEditForm({ name: event.name, sport: "", city: "", eventDate: "", description: "", activityTags: event.activityTags ?? [] });
    setEditError("");
    setShowEditModal(true);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editEvent) return;
    if (editForm.activityTags.length === 0) {
      setEditError("Please select at least one activity type");
      return;
    }
    setEditLoading(true);
    setEditError("");
    try {
      const res = await fetch(`/api/events/${editEvent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update event");
      setShowEditModal(false);
      setEditEvent(null);
      await fetchDashboard();
    } catch (err: any) {
      setEditError(err.message);
    } finally {
      setEditLoading(false);
    }
  };

  const formatDuration = (startedAt: string | null) => {
    if (!startedAt) return "—";
    const diff = Date.now() - new Date(startedAt).getTime();
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const getStatusBadge = (status: string) => {
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
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-900">Dashboard</h1>
            <p className="text-sm text-zinc-500">Pipeline status & active jobs</p>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm text-zinc-600 hover:text-zinc-900">
              Events
            </Link>
            <Link href="/results" className="text-sm text-zinc-600 hover:text-zinc-900">
              Results
            </Link>
            <button
              onClick={() => { setShowCreateModal(true); setCreateError(""); }}
              className="text-sm px-3 py-1.5 rounded-md bg-[var(--accent)] text-white font-medium hover:opacity-90 transition-opacity"
            >
              + Create Event
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {/* Worker health banner */}
        {!workerHealthy && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-800">Background worker is offline</p>
              <p className="text-xs text-amber-700 mt-0.5">Jobs are paused. Run: <code className="bg-amber-100 px-1 py-0.5 rounded">npm run worker</code></p>
            </div>
          </div>
        )}

        {/* Pipeline progress per event */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-zinc-800">Production Pipeline</h2>
            <button
              onClick={() => { setShowCreateModal(true); setCreateError(""); }}
              className="text-xs px-2.5 py-1 rounded bg-[var(--accent)] text-white font-medium hover:opacity-90 transition-opacity"
            >
              + New Event
            </button>
          </div>
          {events.length === 0 && !loading ? (
            <div className="bg-white rounded-lg border border-zinc-200 p-8 text-center">
              <p className="text-sm text-zinc-500 mb-1">No events yet.</p>
              <p className="text-xs text-zinc-400 mb-3">Create your first event to get started.</p>
              <button
                onClick={() => { setShowCreateModal(true); setCreateError(""); }}
                className="text-sm px-4 py-2 rounded-md bg-[var(--accent)] text-white font-medium hover:opacity-90 transition-opacity"
              >
                Create Event
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((event) => {
                const eventCampaigns = campaigns.filter((c) => c.eventId === event.id);
                const campaign = eventCampaigns[0];
                const stages = getPipelineStages(event.status, campaign);

                return (
                  <div key={event.id} className="bg-white rounded-lg border border-zinc-200 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <Link href={`/events/${event.id}`} className="text-sm font-semibold text-zinc-900 hover:text-[var(--accent)] transition-colors">
                          {event.name}
                        </Link>
                        <p className="text-xs text-zinc-500">{event.sport} &middot; {new Date(event.createdAt).toLocaleDateString()}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {campaign && (
                          <span className="text-xs text-zinc-400">{campaign.name}</span>
                        )}
                        <button
                          onClick={() => openEdit(event)}
                          className="text-xs text-zinc-400 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100 transition-colors"
                          title="Edit event"
                        >
                          Edit
                        </button>
                      </div>
                    </div>

                    {/* Stage bar */}
                    <div className="flex items-center gap-1">
                      {stages.map((stage, idx) => {
                        const clickable = stage.url && (stage.status === "complete" || stage.status === "active");

                        return (
                          <div key={idx} className="flex items-center gap-1 flex-1">
                            {clickable ? (
                              <Link href={stage.url!} className="block flex-1">
                                <div
                                  className={`w-full h-2 rounded-full transition-colors ${
                                    stage.status === "complete"
                                      ? "bg-emerald-400"
                                      : stage.status === "active"
                                      ? "bg-blue-400"
                                      : "bg-zinc-200"
                                  }`}
                                  title={`${stage.label}: ${stage.status}`}
                                />
                              </Link>
                            ) : (
                              <div className="block flex-1">
                                <div
                                  className={`w-full h-2 rounded-full transition-colors ${
                                    stage.status === "complete"
                                      ? "bg-emerald-400"
                                      : stage.status === "active"
                                      ? "bg-blue-400"
                                      : "bg-zinc-200"
                                  }`}
                                  title={`${stage.label}: ${stage.status}`}
                                />
                              </div>
                            )}
                            {idx < stages.length - 1 && (
                              <div className="w-3 h-px bg-zinc-200 shrink-0" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between mt-1.5">
                      {stages.map((stage, idx) => (
                        <span key={idx} className="flex-1 text-[10px] text-zinc-400 text-center truncate">
                          {stage.label}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Active jobs table */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-zinc-800">Active Jobs</h2>
            {hasActiveJobs && (
              <span className="inline-flex items-center gap-1 text-xs text-blue-600">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                Polling every 5s
              </span>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-zinc-500">Loading...</p>
          ) : jobs.length === 0 ? (
            <div className="bg-white rounded-lg border border-zinc-200 p-8 text-center">
              <p className="text-sm text-zinc-500">No active jobs.</p>
              <p className="text-xs text-zinc-400 mt-1">All background work is complete.</p>
            </div>
          ) : (
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
                              onClick={() => handleRetry(job.id)}
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
          )}
        </section>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
      </main>

      {/* ── Create Event Modal ───────────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCreateModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-900 mb-4">Create New Event</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700">Event Name</label>
                <input
                  required
                  value={createForm.name}
                  onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-700">Sport</label>
                  <input
                    required
                    value={createForm.sport}
                    onChange={(e) => setCreateForm((p) => ({ ...p, sport: e.target.value }))}
                    className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700">City</label>
                  <input
                    required
                    value={createForm.city}
                    onChange={(e) => setCreateForm((p) => ({ ...p, city: e.target.value }))}
                    className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700">Event Date</label>
                <input
                  type="date"
                  required
                  value={createForm.eventDate}
                  onChange={(e) => setCreateForm((p) => ({ ...p, eventDate: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700">Description</label>
                <textarea
                  rows={2}
                  value={createForm.description}
                  onChange={(e) => setCreateForm((p) => ({ ...p, description: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-zinc-300 rounded-md text-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-2">Activity Type</label>
                <div className="flex flex-wrap gap-2">
                  {["sports","party","play","speech"].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() =>
                        setCreateForm((p) => ({
                          ...p,
                          activityTags: p.activityTags.includes(tag)
                            ? p.activityTags.filter((t) => t !== tag)
                            : [...p.activityTags, tag],
                        }))
                      }
                      className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
                        createForm.activityTags.includes(tag)
                          ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                          : "bg-white text-zinc-600 border-zinc-300 hover:border-zinc-400"
                      }`}
                    >
                      {tag.charAt(0).toUpperCase() + tag.slice(1)}
                    </button>
                  ))}
                </div>
                {createForm.activityTags.length === 0 && (
                  <p className="text-xs text-red-500 mt-1">Select at least one</p>
                )}
              </div>
              {createError && <p className="text-sm text-red-600">{createError}</p>}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="text-sm px-4 py-2 rounded-md text-zinc-700 hover:bg-zinc-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="text-sm px-4 py-2 rounded-md bg-[var(--accent)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {createLoading ? "Creating..." : "Create Event"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit Event Modal ───────────────────────── */}
      {showEditModal && editEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowEditModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-semibold text-zinc-900 mb-4">Edit Event</h2>
            <form onSubmit={handleEdit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700">Event Name</label>
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
                <label className="block text-sm font-medium text-zinc-700">Event Date</label>
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
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-2">Activity Type</label>
                <div className="flex flex-wrap gap-2">
                  {["sports","party","play","speech"].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() =>
                        setEditForm((p) => ({
                          ...p,
                          activityTags: p.activityTags.includes(tag)
                            ? p.activityTags.filter((t) => t !== tag)
                            : [...p.activityTags, tag],
                        }))
                      }
                      className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
                        editForm.activityTags.includes(tag)
                          ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                          : "bg-white text-zinc-600 border-zinc-300 hover:border-zinc-400"
                      }`}
                    >
                      {tag.charAt(0).toUpperCase() + tag.slice(1)}
                    </button>
                  ))}
                </div>
                {editForm.activityTags.length === 0 && (
                  <p className="text-xs text-red-500 mt-1">Select at least one</p>
                )}
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
    </div>
  );
}
