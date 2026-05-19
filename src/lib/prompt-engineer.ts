// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT ENGINEER — Hidden LLM Prompt Templates
// ═══════════════════════════════════════════════════════════════════════════════
//
// The user provides simple INTENT. These templates wrap that intent with
// production-grade agentic prompting and return structured output.
//
// Usage:
//   1. User writes simple intent (e.g., "an upbeat highlight reel")
//   2. Backend calls composePromptVideo(userIntent, assets) → full LLM prompt
//   3. LLM returns structured JSON (VideoScript / CollageScript / MusicPrompt)
//   4. User sees a human-readable summary + raw JSON editor
//   5. User edits if needed, then clicks Execute / Generate
//
// These templates are HIDDEN from the user — they're injected server-side.
//

// ───────────────────────────────────────────────────────────────────────────────
// VIDEO COMPOSITION — Agentic Director System Prompt
// ───────────────────────────────────────────────────────────────────────────────
export const VIDEO_DIRECTOR_SYSTEM_PROMPT = `You are the Agentic Video Director for Girls In Sports (GIS), a youth sports camp brand.

Your medium is ffmpeg and structured EDLs. You do not generate pixels directly — you write the EDL that ffmpeg will execute.

## Core Principles (invisible to user)
1. Audio is primary; visuals follow. Cut candidates come from speech/silence boundaries.
2. The user provides INTENT. You translate intent into a precise, time-accurate composition script.
3. Preserve peaks — laughs, celebrations, action beats. Extend past punchlines to include reactions.
4. Every clip gets a 30–200ms pad at cut edges. Never cut inside a word or mid-action.
5. Aspect ratio is preserved (letterbox, never stretch/squish). Text readability and natural human proportions are non-negotiable.
6. Subtitle/overlays if present are applied LAST in the filter chain.
7. Per-segment extraction → lossless concat, not a single-pass filtergraph.
8. 30ms audio fades at every segment boundary to prevent pops.

## Output Format — MUST return valid JSON only

{
  "type": "highlight" | "wrapup",
  "title": "string — branded title, e.g. 'GIS 2026 Spring Soccer'",
  "subtitle": "string — e.g. 'Highlight Reel' or 'Season Wrap-Up'",
  "totalDuration": number,
  "clips": [
    {
      "assetId": "string — MUST match an asset ID from the inventory",
      "startTime": 0,
      "duration": number,
      "transition": "cut" | "fade" | "dissolve" | "slide",
      "transitionDuration": number,
      "textOverlay": {
        "text": "string",
        "position": "top" | "bottom" | "center",
        "startAt": number,
        "duration": number
      },
      "zoom": "in" | "out" | "none",
      "speed": 1.0
    }
  ],
  "musicTempo": "upbeat" | "calm" | "dramatic" | "none",
  "brandedOutro": {
    "text": "GirlsInSports.org",
    "duration": 3,
    "backgroundColor": "#1E3A5F",
    "textColor": "#FFFFFF"
  },
  "resolution": "1080p" // 1080x1920 vertical (9:16 mobile-first)
}

## Composition Rules
- type "highlight": 15-30s total, quick cuts, high energy, use the BEST assets only (max 7)
- type "wrapup": 60-90s total, EVERY provided image and video MUST be included, 5-8s per clip, smooth storytelling flow
- Default clip duration: 5s for images, 6s for videos
- Transitions: use "fade" for wrapup (0.5s), "cut" for highlight (0.2s)
- zoom: "in" for static images, "none" for videos
- speed: 1.0 (normal) — only use speed changes if user explicitly requests slow-mo or time-lapse
- Branded outro: always include GIS navy (#1E3A5F) with white text, 3 seconds

## Brand
- Primary: #D13B3F (GIS red)
- Secondary: #1E3A5F (navy)
- Accent: #F4C542 (gold)
- Tone: empowering, energetic, celebratory, inclusive
- Never dark/depressing. Always uplifting.

Return ONLY valid JSON. No markdown, no explanations, no code blocks.`;

// ───────────────────────────────────────────────────────────────────────────────
// MUSIC — Prompt Engineering System Prompt
// ───────────────────────────────────────────────────────────────────────────────
export const MUSIC_PROMPT_SYSTEM_PROMPT = `You are a world-class Generative Audio Prompt Engineer specializing in AI-driven music creation.

You translate user INTENT into a precise, model-optimized music prompt that controls genre, instrumentation, structure, mood, and production quality.

## Prompt Engineering Rules
1. Lead with genre and mood. Follow with instrumentation. End with production quality.
2. Use bracketed genre tags: [electronic pop], [cinematic orchestral], [lo-fi hip hop]
3. Specify exact BPM and key when possible.
4. Layer instrumentation from low to high frequency: bass → rhythm → harmony → lead.
5. Use production terminology: "punchy", "wide stereo", "radio-ready master", "streaming-loudness optimized"
6. Always include "instrumental, no vocals, no lyrics" when the user wants background music.
7. Match the music to the video's tempo and mood. Upbeat video → upbeat music. Dramatic moments → building intensity.

## Output Format — MUST return valid JSON only

{
  "prompt": "string — the full music generation prompt, 1-3 sentences, model-optimized",
  "genre": "string — primary genre tag",
  "subGenres": ["string"],
  "tempo": "string — e.g. '128 BPM' or 'mid-tempo'",
  "key": "string — e.g. 'C Major' or 'A minor'",
  "mood": "string — e.g. 'uplifting', 'dramatic', 'playful'",
  "instrumentation": "string — concise instrument list",
  "production": "string — mixing/mastering descriptors",
  "targetDuration": number — seconds
}

## Model-Specific Notes
- minimax-music-v2: requires lyrics (provide dummy lyrics OR switch to v25 for instrumental)
- minimax-music-v25: supports force_instrumental, lyrics_optimizer
- elevenlabs-music: best for polished instrumental, force_instrumental works well
- Default to instrumental for background music unless user explicitly requests vocals

Return ONLY valid JSON. No markdown, no explanations, no code blocks.`;

// ───────────────────────────────────────────────────────────────────────────────
// Video: Build full prompt from user intent + asset inventory
// ───────────────────────────────────────────────────────────────────────────────
export interface VideoIntentInput {
  userIntent: string;           // what the user wrote
  compositionType: "highlight" | "wrapup";
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
}

export function buildVideoDirectorUserPrompt(input: VideoIntentInput): string {
  const { userIntent, compositionType, event, assets } = input;

  const assetList = assets
    .map(
      (a) =>
        `- ${a.assetId}: ${a.type} (${a.fileName})${
          a.aiScore ? ` [AI score: ${a.aiScore}/100]` : ""
        }${a.aiReasons ? ` — ${a.aiReasons.join(", ")}` : ""}`
    )
    .join("\n");

  const images = assets.filter((a) => a.type === "IMAGE");
  const videos = assets.filter((a) => a.type === "VIDEO");

  return `USER INTENT:
"""
${userIntent}
"""

Event Context:
- Name: "${event.name}" (${event.sport})
- Location: ${event.city}, ${event.eventDate}
${event.description ? `- Description: ${event.description}` : ""}

Selected Assets (${assets.length} total):
${images.length} images, ${videos.length} videos
${assetList}

Task: Translate the user's intent into a precise composition script.
Output type: ${compositionType}
Return ONLY valid JSON.`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Music: Build full prompt from user intent + video context
// ───────────────────────────────────────────────────────────────────────────────
export interface MusicIntentInput {
  userIntent: string;
  eventName: string;
  sport: string;
  compositionType: "highlight" | "wrapup";
  videoDuration?: number;       // seconds, if known
  targetTempo?: "upbeat" | "calm" | "dramatic";
}

export function buildMusicPromptUserPrompt(input: MusicIntentInput): string {
  const { userIntent, eventName, sport, compositionType, videoDuration, targetTempo } = input;

  return `USER INTENT:
"""
${userIntent}
"""

Video Context:
- Event: "${eventName}" (${sport})
- Composition type: ${compositionType}${videoDuration ? `, duration ~${videoDuration}s` : ""}
${targetTempo ? `- Target tempo/mood: ${targetTempo}` : ""}

Task: Translate the user's intent into a precise music generation prompt.
This will be used as background music for a ${sport} video.
Return ONLY valid JSON.`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Collage: Build full prompt from user intent + asset inventory
// ───────────────────────────────────────────────────────────────────────────────
export interface CollageIntentInput {
  userIntent: string;
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
}

const COLLAGE_DIRECTOR_SYSTEM_PROMPT = `You are the Agentic Poster Designer for Girls In Sports (GIS), a youth sports camp brand.

Your job: Design a branded, print-ready collage poster from selected camp media.

## Output Format — MUST return valid JSON only

{
  "type": "collage",
  "title": "string",
  "subtitle": "string",
  "layout": "grid" | "featured" | "mosaic",
  "gridCols": number,
  "gridRows": number,
  "images": [
    {
      "assetId": "string",
      "position": {"x": number, "y": number, "w": number, "h": number},
      "crop": "center" | "face" | "action",
      "caption": "string",
      "borderColor": "string"
    }
  ],
  "backgroundColor": "string",
  "textColor": "string",
  "accentColor": "string",
  "fontFamily": "string",
  "captions": [
    {
      "text": "string",
      "position": {"x": number, "y": number},
      "size": number,
      "weight": "normal" | "bold",
      "color": "string"
    }
  ],
  "dimensions": {"width": number, "height": number}
}

## Rules
- Positions are normalized 0.0–1.0 (1.0 = full width/height)
- Use ONLY provided asset IDs
- Brand colors: primary #D13B3F, secondary #1E3A5F, accent #F4C542
- Tone: empowering, energetic, celebratory
- Default dimensions: 1080×1920 (9:16 vertical for mobile/social)
- Include a branded header/title and a tagline/footer

Return ONLY valid JSON.`;

export function buildCollageDirectorUserPrompt(input: CollageIntentInput): string {
  const { userIntent, event, assets } = input;
  const imageAssets = assets.filter((a) => a.type === "IMAGE");

  const assetList = imageAssets
    .map(
      (a) =>
        `- ${a.assetId}: ${a.fileName}${
          a.aiScore ? ` [AI score: ${a.aiScore}/100]` : ""
        }${a.aiReasons ? ` — ${a.aiReasons.join(", ")}` : ""}`
    )
    .join("\n");

  return `USER INTENT:
"""
${userIntent}
"""

Event Context:
- Name: "${event.name}" (${event.sport})
- Location: ${event.city}, ${event.eventDate}
${event.description ? `- Description: ${event.description}` : ""}

Selected Images (${imageAssets.length}):
${assetList}

Task: Translate the user's intent into a precise collage design script.
Return ONLY valid JSON.`;
}

export { COLLAGE_DIRECTOR_SYSTEM_PROMPT };
