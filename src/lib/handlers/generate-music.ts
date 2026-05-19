import { prisma } from "../prisma";
import {
  queueMusicGeneration,
  retrieveMusic,
} from "../music-generation";

const MAX_POLL_ATTEMPTS = 120; // 5s * 120 = 600s = 10 minutes
const POLL_INTERVAL_MS = 5000;

interface MusicPayload {
  campaignId: string;
  eventId: string;
}

export async function handleGenerateMusic({
  payload,
  jobId,
}: {
  payload: unknown;
  jobId: string;
}) {
  const { campaignId, eventId } = payload as MusicPayload;

  console.log(`[generate-music] Starting job ${jobId} for campaign ${campaignId}`);

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { event: true },
  });

  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (!campaign.event) throw new Error(`Event not found for campaign ${campaignId}`);

  // Try to derive music prompt from scriptJson
  let musicMood = "energetic";
  let musicBPMRange: [number, number] = [120, 140];
  try {
    const script = campaign.scriptJson as any;
    if (script?.musicMood) musicMood = script.musicMood;
    if (script?.musicBPMRange && Array.isArray(script.musicBPMRange)) {
      musicBPMRange = [script.musicBPMRange[0], script.musicBPMRange[1]];
    }
  } catch {
    // ignore
  }

  const targetDuration = getTargetDurationSeconds(campaign.targetFormat);
  const prompt = buildMusicPrompt(
    campaign.event.sport,
    campaign.energyPreset,
    musicMood,
    musicBPMRange,
    targetDuration
  );

  // Queue music generation (try elevenlabs-music first, fallback to ACE-Step 1.5)
  let queueId: string;
  let modelUsed: string;
  try {
    const queueResult = await queueMusicGeneration({
      model: "elevenlabs-music",
      prompt,
      durationSeconds: targetDuration + 3, // +3s tail fade buffer
      forceInstrumental: true,
    });
    queueId = queueResult.queueId;
    modelUsed = queueResult.model;
  } catch (err1) {
    console.warn(`[generate-music] elevenlabs-music failed, trying ACE-Step fallback:`, err1);
    try {
      const queueResult = await queueMusicGeneration({
        model: "ace-step" as any,
        prompt,
        durationSeconds: targetDuration + 3,
        forceInstrumental: true,
      });
      queueId = queueResult.queueId;
      modelUsed = queueResult.model;
    } catch (err2) {
      console.error(`[generate-music] Both music models failed:`, err2);
      await markMusicFailed(campaignId, "Music generation failed — both models unavailable");
      return; // Non-fatal: campaign is not blocked
    }
  }

  // Poll until complete
  let completed = false;
  let filePath: string | undefined;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const result = await retrieveMusic(queueId, modelUsed);
      if (result.status === "COMPLETED" && result.filePath) {
        filePath = result.filePath;
        completed = true;
        break;
      }
      if (result.status === "FAILED") {
        throw new Error("Music generation returned FAILED status");
      }
    } catch (pollErr) {
      console.warn(`[generate-music] Poll attempt ${attempt + 1} error:`, pollErr);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!completed || !filePath) {
    console.error(`[generate-music] Timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
    await markMusicFailed(campaignId, "Music generation timed out — render will continue without music");
    return;
  }

  // Store music file path in campaign
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      musicUrl: filePath,
      musicPrompt: prompt,
    },
  });

  console.log(`[generate-music] Music ready at ${filePath} for campaign ${campaignId}`);
}

function getTargetDurationSeconds(format: string): number {
  switch (format) {
    case "REEL_15":
    case "AD_15":
      return 15;
    case "REEL_30":
    case "AD_30":
      return 30;
    case "REEL_60":
    case "HIGHLIGHT_60":
      return 60;
    default:
      return 30;
  }
}

function buildMusicPrompt(
  sport: string,
  energyPreset: string,
  musicMood: string,
  bpmRange: [number, number],
  durationSeconds: number
): string {
  const energyDesc: Record<string, string> = {
    HYPE: "high energy, fast-paced, explosive",
    INSPIRATIONAL: "uplifting, empowering, anthemic",
    EMOTIONAL: "deep, heartfelt, stirring",
    INSTRUCTIONAL: "clean, focused, motivating",
  };

  return `Instrumental background music for a ${sport} sports video. 
Mood: ${musicMood}. Energy: ${energyDesc[energyPreset] || energyDesc.HYPE}. 
Tempo: ${bpmRange[0]}-${bpmRange[1]} BPM. Duration: ${durationSeconds}s.
Youth sports camp atmosphere — empowering, uplifting, building confidence through athletics.
Clean production, punchy drums, bright synths, modern pop-rock.
No vocals, no lyrics — pure instrumental. Streaming-loudness optimized.`;
}

async function markMusicFailed(campaignId: string, error: string) {
  console.warn(`[generate-music] Marking music failed for campaign ${campaignId}: ${error}`);
  // Only update musicUrl to indicate failure; do NOT change campaign status
  // RENDER_PROXY should check if musicUrl exists and is not empty
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      musicUrl: `failed:${error}`,
    },
  });
}
