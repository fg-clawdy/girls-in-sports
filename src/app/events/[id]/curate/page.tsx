"use client";

import { useParams } from "next/navigation";
import { useEffect } from "react";

export default function CurateRedirectPage() {
  const { id } = useParams();
  const eventId = Array.isArray(id) ? id[0] : id;

  useEffect(() => {
    if (eventId) {
      window.location.href = `/events/${eventId}`;
    }
  }, [eventId]);

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
      <p className="text-zinc-500">Redirecting to event page...</p>
    </div>
  );
}
