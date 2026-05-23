import { prisma } from "@/lib/prisma";
import { recordJobOutcome } from "@/lib/cost-estimator";

/**
 * US-014: Consistent quality flag + error recording helper.
 * Use this in every job handler to ensure failures are visible to users,
 * circuit breakers trigger, and graceful degradation is auditable.
 */

export interface StageQualityFlags {
  failed?: boolean;
  error?: string;
  fallbackUsed?: boolean;
  visionFailedBatches?: number;
  visionUsedFallback?: boolean;
  message?: string;
  [key: string]: any;
}

export async function recordQualityFlags(
  jobId: string | undefined,
  stage: string,
  flags: Partial<StageQualityFlags>
): Promise<void> {
  if (!jobId) return;
  try {
// US-014: derive eventId from payload (Job has no direct eventId column)
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { qualityFlags: true, payload: true },
    });
    if (!job) return;

    const current = (job.qualityFlags as Record<string, any>) || {};
    const updated: Record<string, any> = {
      ...current,
      [stage]: {
        ...(current[stage] || {}),
        ...flags,
        timestamp: new Date().toISOString(),
      },
    };

// US-014: cast required because Prisma's generated JobUpdateInput can lag on new Json fields
    await prisma.job.update({
      where: { id: jobId },
      data: { qualityFlags: updated } as any,
    });

    // Trigger circuit breaker on failure (eventId lives inside payload)
    const eventIdFromPayload = (job.payload as any)?.eventId;
    if (flags.failed && eventIdFromPayload) {
      recordJobOutcome(eventIdFromPayload, false);
    }
  } catch (e) {
    // Never let tracking break the main flow
    console.error("[US-014] recordQualityFlags failed (non-fatal):", e);
  }
}

export async function recordJobError(
  jobId: string | undefined,
  error: Error | string,
  stage?: string
): Promise<void> {
  if (!jobId) return;
  const msg = error instanceof Error ? error.message : String(error);
  try {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        error: msg,
        // Do NOT force FAILED here — let the worker decide retry vs final dead-letter
      },
    });
    if (stage) {
      await recordQualityFlags(jobId, stage, { failed: true, error: msg });
    }
  } catch (e) {
    console.error("[US-014] recordJobError failed (non-fatal):", e);
  }
}

export async function markPartialSuccess(
  jobId: string | undefined,
  stage: string,
  message: string,
  extra?: Partial<StageQualityFlags>
): Promise<void> {
  if (!jobId) return;
  await recordQualityFlags(jobId, stage, {
    fallbackUsed: true,
    message,
    ...extra,
  });
}