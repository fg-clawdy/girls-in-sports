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

  useEffect(() => {
    fetch("/api/events")
      .then((res) => res.json())
      .then((data) => {
        if (data.events) {
          setEvents(data.events);
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load events");
        setLoading(false);
      });
  }, []);

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
            onClick={() => alert("Event creation coming soon!")}
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
    </div>
  );
}
