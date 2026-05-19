import { prisma } from "@/lib/prisma";
import { JobType } from "@prisma/client";
import { enqueueJob } from "../job-worker";

const VENICE_URL = process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_KEY = process.env.VENICE_API_KEY || "";
const DIRECTOR_MODEL = process.env.DIRECTOR_MODEL || "qwen-qwq-32b";

const TARGET_DURATION_MS: Record<string, number> = {
  REEL_15: 15000,
  REEL_30: 30000,
  REEL_60: 60000,
  AD_15: 15000,
  AD_30: 30000,
  HIGHLIGHT_60: 60000,
};

const MAX_RETRIES = 2;

interface DirectorPayload {
  campaignId: string;
  eventId: string;
  selectedAssetIds: string[];
  mustIncludeAssetIds: string[];
}

interface ProductionScript {
  narrativeArc: string;
  pacingStyle: string;
  musicMood: string;
  musicBPMRange: [number, number];
  clips: Array<{
    assetId: string;
    startTimeMs: number;
    endTimeMs: number;
    durationMs: number;
    narrativeLabel: string;
    textOverlay: string | null;
    order: number;
  }>;
  totalDurationMs: number;
}

export async function handleDirectScript({
  payload,
  jobId,
}: {
  payload: unknown;
  jobId: string;
}) {
  const { campaignId, eventId, selectedAssetIds, mustIncludeAssetIds } =
    payload as DirectorPayload;

  console.log(`[direct-script] Starting job ${jobId} for campaign ${campaignId}`);

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      event: true,
      campaignClips: { include: { asset: { include: { clipScore: true, assetTags: true } } } },
    },
  });

  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (!campaign.event) throw new Error(`Event not found for campaign ${campaignId}`);

  const targetMs = TARGET_DURATION_MS[campaign.targetFormat];
  if (!targetMs) throw new Error(`Unknown target format: ${campaign.targetFormat}`);

  const acceptedClips = campaign.campaignClips
    .filter((cc) => cc.accepted && cc.asset)
    .map((cc) => ({
      assetId: cc.assetId,
      immichAssetId: cc.asset.immichAssetId,
      compositeScore: cc.asset.clipScore?.compositeScore ?? 0,
      clipType: cc.asset.clipScore?.clipType ?? "MONTAGE",
      durationSeconds: cc.asset.durationSeconds ?? 0,
      transcriptExcerpt: cc.asset.clipScore?.transcriptExcerpt ?? null,
      tags: cc.asset.assetTags.map((t) => t.tag),
      mustInclude: cc.mustInclude,
    }));

  // Retry loop
  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const script = await generateScript(
        campaign,
        campaign.event,
        acceptedClips,
        mustIncludeAssetIds,
        targetMs,
        attempt > 0 ? lastError : undefined
      );

      // Validate must-includes present
      const scriptAssetIds = new Set(script.clips.map((c) => c.assetId));
      for (const mid of mustIncludeAssetIds) {
        if (!scriptAssetIds.has(mid)) {
          throw new Error(`Must-include clip ${mid} missing from script`);
        }
      }

      // Validate timestamps within clip duration
      const assetMap = new Map(
        acceptedClips.map((c) => [c.assetId, c])
      );
      for (const clip of script.clips) {
        const src = assetMap.get(clip.assetId);
        if (!src) throw new Error(`Script references unknown asset ${clip.assetId}`);
        const maxMs = Math.round((src.durationSeconds || 0) * 1000);
        if (clip.startTimeMs < 0 || clip.endTimeMs > maxMs) {
          throw new Error(
            `Clip ${clip.assetId} timestamps ${clip.startTimeMs}-${clip.endTimeMs} exceed duration ${maxMs}ms`
          );
        }
        const actualDur = clip.endTimeMs - clip.startTimeMs;
        if (Math.abs(actualDur - clip.durationMs) > 50) {
          // Minor tolerance mismatch — fix it
          clip.durationMs = actualDur;
        }
      }

      // Validate total duration within ±10%
      const total = script.totalDurationMs;
      const deviation = Math.abs(total - targetMs) / targetMs;
      if (deviation > 0.1) {
        throw new Error(
          `Total duration ${total}ms is ${(deviation * 100).toFixed(1)}% off target ${targetMs}ms`
        );
      }

      // Persist
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          scriptJson: script as any,
          status: "SCRIPTED",
        },
      });

      // Enqueue parallel jobs: GENERATE_MUSIC and RENDER_PROXY
      await Promise.all([
        enqueueJob(JobType.GENERATE_MUSIC, {
          campaignId,
          eventId,
        }),
        enqueueJob(JobType.RENDER_PROXY, {
          campaignId,
          eventId,
        }),
      ]);

      console.log(`[direct-script] Campaign ${campaignId} scripted successfully`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      console.error(`[direct-script] Attempt ${attempt + 1} failed: ${msg}`);
      if (attempt === MAX_RETRIES) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "FAILED" },
        });
        throw new Error(`DIRECT_SCRIPT failed after ${MAX_RETRIES + 1} attempts: ${msg}`);
      }
    }
  }
}

async function generateScript(
  campaign: any,
  event: any,
  acceptedClips: any[],
  mustIncludeAssetIds: string[],
  targetMs: number,
  correctionHint?: string
): Promise<ProductionScript> {
  const clipManifest = acceptedClips.map((c) => ({
    clipId: c.assetId,
    compositeScore: c.compositeScore,
    clipType: c.clipType,
    durationSeconds: c.durationSeconds,
    transcriptExcerpt: c.transcriptExcerpt
      ? c.transcriptExcerpt.slice(0, 200)
      : null,
    tags: c.tags,
    mustInclude: mustIncludeAssetIds.includes(c.assetId),
  }));

  const jsonSchema = {
    name: "ProductionScript",
    strict: true,
    schema: {
      type: "object",
      properties: {
        narrativeArc: { type: "string" },
        pacingStyle: {
          type: "string",
          enum: ["fast", "moderate", "slow", "mixed"],
        },
        musicMood: { type: "string" },
        musicBPMRange: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
        },
        clips: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assetId: { type: "string" },
              startTimeMs: { type: "number" },
              endTimeMs: { type: "number" },
              durationMs: { type: "number" },
              narrativeLabel: { type: "string" },
              textOverlay: { type: ["string", "null"] },
              order: { type: "number" },
            },
            required: [
              "assetId",
              "startTimeMs",
              "endTimeMs",
              "durationMs",
              "narrativeLabel",
              "order",
            ],
            additionalProperties: false,
          },
        },
        totalDurationMs: { type: "number" },
      },
      required: [
        "narrativeArc",
        "pacingStyle",
        "musicMood",
        "musicBPMRange",
        "clips",
        "totalDurationMs",
      ],
      additionalProperties: false,
    },
  };

  const systemPrompt = `You are the Agentic Video Director for Girls In Sports (GIS), a youth sports camp brand.

You produce a structured ProductionScript JSON from curated clips. Your decisions reflect genuine editorial intelligence — pacing, narrative arc, emotional beats — not just sorted scores.

## Rules
1. Every clip in the output must exist in the provided manifest. Do NOT invent assetIds.
2. All mustInclude=true clips MUST appear in the output.
3. Clip startTimeMs/endTimeMs must fall within the source clip's actual duration (0 to durationSeconds*1000).
4. Total duration (sum of durationMs) must be within ±10% of the target duration.
5. Respect the user's creative brief and energy preset. Adapt pacing to match.
6. narrativeArc should describe the emotional/story arc in 1-2 sentences.
7. musicMood and musicBPMRange guide the music generation step.
8. textOverlay can be null or a short caption string for the clip.
9. order is 0-indexed and determines playback sequence.
10. narrativeLabel is a brief editorial note (e.g., "Opening energy burst", "Coach speech reflection").
11. pacingStyle must be one of: fast, moderate, slow, mixed.

## Brand
- Primary: #D13B3F (GIS red)
- Secondary: #1E3A5F (navy)
- Accent: #F4C542 (gold)
- Tone: empowering, energetic, celebratory, inclusive. Never dark/depressing.`;

  const userPrompt = `Event: "${event.name}" (${event.sport}) — ${event.city}, ${event.eventDate}

Target Format: ${campaign.targetFormat} (target duration ${targetMs}ms ≈ ${(targetMs / 1000).toFixed(0)}s)
Creative Brief: ${campaign.brief || "None provided — use your best judgment."}
Energy Preset: ${campaign.energyPreset}

Accepted Clips (${clipManifest.length}):
${JSON.stringify(clipManifest, null, 2)}

${correctionHint ? `\n## CORRECTION NEEDED\nThe previous attempt failed with: ${correctionHint}\nPlease fix this issue and ensure all rules above are satisfied.\n` : ""}

Generate the ProductionScript JSON now.`;

  const res = await fetch(`${VENICE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VENICE_KEY}`,
    },
    body: JSON.stringify({
      model: DIRECTOR_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      reasoning_effort: "high",
      venice_parameters: {
        include_venice_system_prompt: false,
        strip_thinking_response: true,
      },
      response_format: {
        type: "json_schema",
        json_schema: jsonSchema,
      },
      temperature: 0.4,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Venice API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";

  let parsed: ProductionScript;
  try {
    parsed = JSON.parse(content) as ProductionScript;
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content.slice(0, 500)}`);
  }

  // Ensure totalDurationMs is consistent
  const computedTotal = parsed.clips.reduce((sum, c) => sum + c.durationMs, 0);
  parsed.totalDurationMs = computedTotal;

  return parsed;
}
