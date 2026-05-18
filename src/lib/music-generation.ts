// Venice.ai Music Generation Client
// Handles queue → poll → retrieve flow for background music

import { promises as fs } from "fs";
import * as path from "path";

const VENICE_URL = process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_KEY = process.env.VENICE_API_KEY || "";
const OUTPUT_DIR = process.env.COMPOSITION_OUTPUT_DIR || "/tmp/gis-compositions";

export interface MusicGenerationRequest {
  model: "minimax-music-v2" | "minimax-music-v25" | "minimax-music-v26" | "elevenlabs-music";
  prompt: string;
  lyrics?: string;
  durationSeconds?: number;
  forceInstrumental?: boolean;
}

export interface MusicGenerationResult {
  queueId: string;
  model: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  filePath?: string;
  fileName?: string;
  error?: string;
}

export interface VeniceMusicModel {
  id: string;
  name: string;
  description: string;
  pricingUsd: number;
  supportsInstrumental: boolean;
  requiresLyrics: boolean;
  maxDuration: number;
  supportsLyricsOptimizer: boolean;
}

export async function getMusicModels(): Promise<VeniceMusicModel[]> {
  const res = await fetch(`${VENICE_URL}/models?type=music`, {
    headers: { Authorization: `Bearer ${VENICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch music models: ${res.status}`);
  const data = await res.json();
  const models = Array.isArray(data) ? data : data.data || [];

  return models.map((m: any) => {
    const spec = m.model_spec || {};
    const pricing = spec.pricing || {};
    const usdPrice = (pricing.generation?.usd as number | undefined) ?? (Object.values(pricing.durations || {})[0] as any)?.usd ?? 0;
    return {
      id: m.id,
      name: spec.name || m.id,
      description: spec.description || "",
      pricingUsd: usdPrice,
      supportsInstrumental: spec.supports_force_instrumental || false,
      requiresLyrics: spec.lyrics_required || false,
      maxDuration: spec.max_duration || 60,
      supportsLyricsOptimizer: spec.supports_lyrics_optimizer || false,
    };
  });
}

export async function queueMusicGeneration(
  req: MusicGenerationRequest
): Promise<{ queueId: string; model: string }> {
  const body: any = {
    model: req.model,
    prompt: req.prompt,
  };

  if (req.durationSeconds) {
    body.duration_seconds = req.durationSeconds;
  }
  if (req.lyrics) {
    body.lyrics_prompt = req.lyrics;
  }
  if (req.forceInstrumental) {
    body.force_instrumental = true;
  }

  const res = await fetch(`${VENICE_URL}/audio/queue`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VENICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      data.error?.message || data.message || `Music generation failed: ${res.status}`
    );
  }

  return {
    queueId: data.queue_id,
    model: req.model,
  };
}

export async function retrieveMusic(
  queueId: string,
  model: string
): Promise<MusicGenerationResult> {
  const res = await fetch(`${VENICE_URL}/audio/retrieve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VENICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      queue_id: queueId,
      delete_media_on_completion: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Retrieve failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("audio/") || contentType.includes("application/octet")) {
    // Audio data returned — save it
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = contentType.includes("wav") ? "wav" : contentType.includes("flac") ? "flac" : "mp3";
    const workDir = path.join(OUTPUT_DIR, "music", queueId);
    await fs.mkdir(workDir, { recursive: true });
    const filePath = path.join(workDir, `music.${ext}`);
    await fs.writeFile(filePath, buffer);

    return {
      queueId,
      model,
      status: "COMPLETED",
      filePath,
      fileName: `music.${ext}`,
    };
  }

  // JSON status response
  const data = await res.json();
  return {
    queueId,
    model,
    status: data.status === "PROCESSING" ? "PROCESSING" : "QUEUED",
  };
}

export async function pollForMusic(
  queueId: string,
  model: string,
  maxAttempts = 60,
  delayMs = 5000
): Promise<MusicGenerationResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await retrieveMusic(queueId, model);
    if (result.status === "COMPLETED" && result.filePath) {
      return result;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Music generation timed out after polling");
}

// Music Prompt Engineer — refine user intent into production-grade music prompt
// Uses the same LLM as composition generation (Venice API)

import {
  MUSIC_PROMPT_SYSTEM_PROMPT,
  buildMusicPromptUserPrompt,
} from "./prompt-engineer";

export interface MusicRefineInput {
  userIntent: string;
  eventName: string;
  sport: string;
  compositionType: "highlight" | "wrapup";
  targetTempo?: "upbeat" | "calm" | "dramatic";
}

export async function refineMusicPromptWithLLM(
  input: MusicRefineInput
): Promise<string> {
  const config = getConfig();
  const prompt = buildMusicPromptUserPrompt({
    userIntent: input.userIntent,
    eventName: input.eventName,
    sport: input.sport,
    compositionType: input.compositionType,
    videoDuration: undefined,
    targetTempo: input.targetTempo || "upbeat",
  });

  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: MUSIC_PROMPT_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 2000,
    temperature: 0.5,
  };

  const res = await fetch(`${config.apiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Music prompt refinement error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const rawContent: string = data.choices?.[0]?.message?.content || "";

  // Extract JSON
  let jsonStr = rawContent;
  const codeBlockMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  } else {
    const firstBrace = rawContent.indexOf("{");
    const lastBrace = rawContent.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = rawContent.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    // Return the refined prompt string
    return parsed.prompt || rawContent;
  } catch {
    // Fallback: return the raw content cleaned up
    return rawContent.replace(/```/g, "").trim();
  }
}

// Reuse composition config for LLM calls
function getConfig() {
  return {
    apiUrl: process.env.COMPOSITION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1",
    apiKey: process.env.COMPOSITION_API_KEY || process.env.VENICE_API_KEY || "",
    model: process.env.COMPOSITION_MODEL || process.env.VENICE_MODEL || "z-ai-glm-5-turbo",
  }
}

export async function generateMusicPromptFromVideo(
  eventName: string,
  sport: string,
  compositionType: "highlight" | "wrapup",
  targetTempo: "upbeat" | "calm" | "dramatic"
): Promise<string> {
  const tempoMap: Record<string, string> = {
    upbeat: "uptempo, energetic, driving rhythm",
    calm: "mid-tempo, warm, inspirational",
    dramatic: "building intensity, cinematic, emotional peaks",
  };

  return `Instrumental ${sport} sports background music. ${tempoMap[targetTempo] || tempoMap.upbeat}. Youth sports camp atmosphere — empowering, uplifting, building confidence through athletics. Clean production with clear dynamics. No vocals, no lyrics — pure instrumental. Suitable for a ${compositionType === "highlight" ? "fast-paced highlight reel" : "wrap-up celebration video"} for Girls In Sports event "${eventName}". Modern pop-rock production with punchy drums, bright synths, and anthemic chord progressions. Streaming-loudness optimized.`;
}
