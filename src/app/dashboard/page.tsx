"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface EventItem {
  id: string;
  name: string;
  sport: string;
  city: string;
  eventDate: string;
  description: string | null;
  immichAlbumId: string | null;
  createdAt: string;
}

export default function DashboardPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [form, setForm] = useState({
    name: "",
    sport: "",
    city: "",
    eventDate: "",
    description: "",
  });

  async function loadEvents() {
    setLoading(true);
    try {
      const res = await fetch("/api/events");
      const data = await res.json();
      if (data.events) {
        setEvents(data.events);
      }
      setError("");
    } catch {
      setError("Failed to load events");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.error || "Failed to create event");
        setCreating(false);
        return;
      }
      setShowModal(false);
      setForm({ name: "", sport: "", city: "", eventDate: "", description: "" });
      await loadEvents();
    } catch {
      setCreateError("Network error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b border-zinc-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-900">Girls In Sports</h1>
            <p className="text-sm text-zinc-500">Media Catalog & Marketing Composer</p>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/results" className="text-sm text-zinc-600 hover:text-zinc-900">
              Results Catalog
            </Link>
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="text-sm text-zinc-600 hover:text-zinc-900"
              >
                Log Out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-zinc-900">Events</h2>
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)]"
          >
            + New Event
          </button>
        </div>

        {loading && (
          <p className="text-zinc-500">Loading events...</p>
        )}

        {error && (
          <p className="text-red-600">{error}</p>
        )}

        {!loading && events.length === 0 && (
          <div className="bg-white rounded-lg border border-zinc-200 p-8 text-center">
            <p className="text-zinc-500 mb-2">No events yet.</p>
            <p className="text-sm text-zinc-400">
              Create an event to start cataloging media from your camps.
            </p>
          </div>
        )}

        <div className="grid gap-4">
          {events.map((event) => (
            <Link
              key={event.id}
              href={`/events/${event.id}`}
              className="block bg-white rounded-lg border border-zinc-200 p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-zinc-900">{event.name}</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    {event.sport} &middot; {event.city} &middot;{" "}
                    {new Date(event.eventDate).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                  {event.description && (
                    <p className="text-sm text-zinc-600 mt-2">{event.description}</p>
                  )}
                </div>
                {event.immichAlbumId && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
                    Immich
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </main>

      {/* Create Event Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-zinc-900 mb-4">Create New Event</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Event Name</label>
                <input
                  required
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  placeholder="e.g. Summer Camp 2026"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Sport</label>
                <input
                  required
                  type="text"
                  value={form.sport}
                  onChange={(e) => setForm({ ...form, sport: e.target.value })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  placeholder="e.g. Soccer, Basketball"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">City</label>
                <input
                  required
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  placeholder="e.g. Atlanta"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Event Date</label>
                <input
                  required
                  type="date"
                  value={form.eventDate}
                  onChange={(e) => setForm({ ...form, eventDate: e.target.value })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">Description</label>
                <textarea
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-zinc-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  placeholder="Optional notes about the event..."
                />
              </div>

              {createError && (
                <p className="text-sm text-red-600">{createError}</p>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create Event"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
