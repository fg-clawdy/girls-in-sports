import { NextResponse } from "next/server";
import { promises as fs } from "fs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  // Security: only allow paths inside the compositions output dir
  const allowedPrefix = process.env.COMPOSITION_OUTPUT_DIR || "/tmp/gis-compositions";
  if (!filePath.startsWith(allowedPrefix)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 404 });
    }

    const file = await fs.readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() || "mp3";
    const mimeTypes: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      flac: "audio/flac",
      m4a: "audio/mp4",
      ogg: "audio/ogg",
    };

    return new NextResponse(file, {
      headers: {
        "Content-Type": mimeTypes[ext] || "audio/mpeg",
        "Content-Length": String(stats.size),
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
