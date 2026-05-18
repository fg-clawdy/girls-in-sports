import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAlbum, isImmichConfigured } from "@/lib/immich";

export async function POST(request: Request) {
  try {
    const { name, sport, city, eventDate, description } = await request.json();

    if (!name || !sport || !city || !eventDate) {
      return NextResponse.json(
        { error: "Name, sport, city, and eventDate are required" },
        { status: 400 }
      );
    }

    let immichAlbumId: string | null = null;

    if (isImmichConfigured()) {
      try {
        const albumName = `GIS ${sport} ${city} ${new Date(eventDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
        const immichAlbum = await createAlbum(
          albumName,
          description || `${name} - ${sport} camp in ${city}`
        );
        immichAlbumId = immichAlbum.id;
      } catch (immichError) {
        console.warn("Failed to create Immich album:", immichError);
      }
    }

    const event = await prisma.event.create({
      data: {
        name,
        sport,
        city,
        eventDate: new Date(eventDate),
        description: description || null,
        immichAlbumId,
      },
    });

    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    console.error("Create event error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create event" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const events = await prisma.event.findMany({
      orderBy: { eventDate: "desc" },
    });
    return NextResponse.json({ events });
  } catch (error) {
    console.error("Get events error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch events" },
      { status: 500 }
    );
  }
}
