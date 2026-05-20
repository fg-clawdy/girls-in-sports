import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { JobStatus } from "@prisma/client";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.update({
      where: { id: params.id },
      data: {
        status: JobStatus.QUEUED,
        attempts: 0,
        error: null,
        retryAfter: null,
      },
    });

    return NextResponse.json({ job });
  } catch (error) {
    console.error("POST /jobs/[id]/retry error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to retry job" },
      { status: 500 }
    );
  }
}
