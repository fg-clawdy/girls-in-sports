// Model-agnostic composition script generation for GIS
// The LLM is the "director" — it plans, does not generate pixels

interface CompositionConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

function getConfig(): CompositionConfig {
  return {
    apiUrl: process.env.COMPOSITION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1",
    apiKey: process.env.COMPOSITION_API_KEY || process.env.VENICE_API_KEY || "",
    model: process.env.COMPOSITION_MODEL || process.env.VENICE_MODEL || "z-ai-glm-5-turbo",
  };
}

export function isCompositionConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.apiKey && cfg.apiUrl);
}

export interface CollageScript {
  type: "collage";
  title: string;
  subtitle: string;
  layout: "grid" | "featured" | "mosaic";
  gridCols?: number;
  gridRows?: number;
  images: Array<{
    assetId: string;
    position: { x: number; y: number; w: number; h: number }; // normalized 0-1
    crop?: "center" | "face" | "action";
    caption?: string;
    borderColor?: string;
  }>;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: string;
  captions: Array<{
    text: string;
    position: { x: number; y: number };
    size: number;
    weight: "normal" | "bold";
    color: string;
  }>;
  dimensions: { width: number; height: number };
}

export interface VideoScript {
  type: "highlight" | "wrapup";
  title: string;
  subtitle: string;
  totalDuration: number; // seconds
  clips: Array<{
    assetId: string;
    startTime: number;
    duration: number;
    transition: "cut" | "fade" | "dissolve" | "slide";
    transitionDuration: number;
    textOverlay?: {
      text: string;
      position: "top" | "bottom" | "center";
      startAt: number;
      duration: number;
    };
    zoom?: "in" | "out" | "none";
    speed?: number; // 1.0 = normal
  }>;
  musicTempo: "upbeat" | "calm" | "dramatic" | "none";
  musicFile?: string; // optional path to background music file
  brandedOutro: {
    text: string;
    duration: number;
    backgroundColor: string;
    textColor: string;
  };
  resolution: "1080p" | "720p" | "4K";
}

export type CompositionScript = CollageScript | VideoScript;

export interface CompositionInput {
  event: {
    name: string;
    sport: string;
    city: string;
    eventDate: string;
    description?: string | null;
  };
  assets: Array<{
    assetId: string;
    fileName: string;
    type: "IMAGE" | "VIDEO";
    aiScore?: number;
    aiReasons?: string[];
  }>;
  outputType: "collage" | "highlight" | "wrapup";
}

const SYSTEM_PROMPT = `You are the Creative Director for Girls In Sports (GIS), a youth sports camp and coaching clinic brand.

Your job: Write a detailed composition script for marketing material based on selected camp media.

Rules:
- Return ONLY valid JSON. No markdown, no explanations, no code blocks.
- All positions are normalized (0.0 to 1.0) where 1.0 = full width/height.
- Use ONLY the provided asset IDs. Do not invent IDs.
- Brand colors: primary #D13B3B (GIS red), secondary #1E3A5F (navy), accent #F4C542 (gold).
- Captions should be energetic, empowering, and focused on girls in sports.
- For videos, total duration must match the sum of clip durations minus overlaps.

Output format depends on outputType:

COLLAGE: {type:"collage", title:string, subtitle:string, layout:"grid"|"featured"|"mosaic", gridCols:number, gridRows:number, images:[{assetId, position:{x,y,w,h}, crop?:"center"|"face"|"action", caption?:string, borderColor?:string}], backgroundColor:string, textColor:string, accentColor:string, fontFamily:string, captions:[{text, position:{x,y}, size:number, weight, color}], dimensions:{width,height}}

VIDEO: {type:"highlight"|"wrapup", title:string, subtitle:string, totalDuration:number, clips:[{assetId, startTime, duration, transition:"cut"|"fade"|"dissolve"|"slide", transitionDuration, textOverlay?:{text, position:"top"|"bottom"|"center", startAt, duration}, zoom?:"in"|"out"|"none", speed?:number}], musicTempo:"upbeat"|"calm"|"dramatic"|"none", brandedOutro:{text, duration, backgroundColor, textColor}, resolution:"1080p"|"720p"|"4K"}`;

function buildUserPrompt(input: CompositionInput): string {
  const { event, assets, outputType } = input;

  const assetList = assets
    .map(
      (a) =>
        `- ${a.assetId}: ${a.type} (${a.fileName})${
          a.aiScore ? ` [AI score: ${a.aiScore}/100]` : ""
        }${a.aiReasons ? ` — ${a.aiReasons.join(", ")}` : ""}`
    )
    .join("\n");

  const outputDesc =
    outputType === "collage"
      ? "a Collage Poster (print-ready, grid layout, branded captions)"
      : outputType === "highlight"
      ? "a 15-second Highlight Video (quick cuts, high energy, minimal transitions, use best 5-7 clips)"
      : "a Full Wrap-up Video (60-90 seconds, EVERY provided image and video MUST be included as a clip, each shown 5-8 seconds, smooth storytelling flow)";

  return `Event: "${event.name}" (${event.sport}) — ${event.city}, ${event.eventDate}
${event.description ? `Description: ${event.description}` : ""}

Output: ${outputDesc}

Selected Assets (${assets.length}):
${assetList}

Write the composition script.`;
}

async function callCompositionLLM(
  config: CompositionConfig,
  input: CompositionInput
): Promise<CompositionScript> {
  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
    max_tokens: 4000,
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
    throw new Error(`Composition API error: ${res.status} ${text}`);
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

    // Validate required fields
    if (!parsed.type) {
      throw new Error("Missing 'type' field in composition script");
    }
    if (!Array.isArray(parsed.images || parsed.clips)) {
      throw new Error("Missing images/clips array in composition script");
    }

    return parsed as CompositionScript;
  } catch (parseErr) {
    console.error("Failed to parse composition response:", rawContent.substring(0, 1000));
    throw new Error(
      `Invalid composition script JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
    );
  }
}

/**
 * Generate a composition script using an LLM.
 * Falls back to a simple default script if the LLM is unavailable.
 */
export async function generateCompositionScript(
  input: CompositionInput
): Promise<{ script: CompositionScript; modelUsed: string }> {
  const config = getConfig();

  if (!isCompositionConfigured()) {
    // Generate a simple fallback script
    const fallbackScript = generateFallbackScript(input);
    return { script: fallbackScript, modelUsed: "fallback" };
  }

  const script = await callCompositionLLM(config, input);
  return { script, modelUsed: config.model };
}

function generateFallbackScript(input: CompositionInput): CompositionScript {
  const { event, assets, outputType } = input;
  const imageAssets = assets.filter((a) => a.type === "IMAGE");
  const videoAssets = assets.filter((a) => a.type === "VIDEO");

  if (outputType === "collage") {
    const count = Math.min(imageAssets.length, 6);
    const cols = count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);

    return {
      type: "collage",
      title: event.name,
      subtitle: `${event.sport} • ${event.city} • ${event.eventDate}`,
      layout: "grid",
      gridCols: cols,
      gridRows: rows,
      images: imageAssets.slice(0, count).map((a, i) => ({
        assetId: a.assetId,
        position: {
          x: (i % cols) / cols,
          y: Math.floor(i / cols) / rows,
          w: 1 / cols,
          h: 1 / rows,
        },
        crop: "center",
        borderColor: "#D13B3B",
      })),
      backgroundColor: "#FFFFFF",
      textColor: "#1E3A5F",
      accentColor: "#D13B3B",
      fontFamily: "Inter",
      captions: [
        {
          text: event.name.toUpperCase(),
          position: { x: 0.5, y: 0.05 },
          size: 48,
          weight: "bold",
          color: "#1E3A5F",
        },
        {
          text: `${event.sport} • ${event.city}`,
          position: { x: 0.5, y: 0.95 },
          size: 24,
          weight: "normal",
          color: "#666666",
        },
      ],
      dimensions: { width: 2400, height: 3200 },
    };
  }

  // Video fallback — use ALL images AND videos, longer durations
  const allAssets = [...imageAssets, ...videoAssets];
  const clipDuration = outputType === "highlight" ? 2 : 6;
  const totalDuration = outputType === "highlight"
    ? Math.min(allAssets.length * clipDuration, 15)
    : allAssets.length * clipDuration;
  const selectedAssets = outputType === "highlight"
    ? allAssets.slice(0, Math.floor(15 / clipDuration))
    : allAssets;

  return {
    type: outputType,
    title: event.name,
    subtitle: `${event.sport} • ${event.city}`,
    totalDuration,
    clips: selectedAssets.map((a, i) => ({
      assetId: a.assetId,
      startTime: i * clipDuration,
      duration: clipDuration,
      transition: i === 0 ? "cut" : "fade",
      transitionDuration: 0.5,
      textOverlay:
        i === 0
          ? {
              text: event.name,
              position: "bottom",
              startAt: 0,
              duration: 2,
            }
          : undefined,
      zoom: i % 2 === 0 ? "in" : "none",
      speed: 1,
    })),
    musicTempo: "upbeat",
    brandedOutro: {
      text: "Girls In Sports — Building Confidence Through Athletics",
      duration: 3,
      backgroundColor: "#1E3A5F",
      textColor: "#FFFFFF",
    },
    resolution: "1080p",
  };
}
