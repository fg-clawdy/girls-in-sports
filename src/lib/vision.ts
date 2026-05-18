// Model-agnostic vision analysis layer for GIS
// Supports Venice.ai, OpenAI, Anthropic, or any OpenAI-compatible endpoint

interface VisionModelConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  provider: "venice" | "openai" | "anthropic" | "generic";
}

function getConfig(): VisionModelConfig {
  return {
    apiUrl: process.env.VISION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1",
    apiKey: process.env.VISION_API_KEY || process.env.VENICE_API_KEY || "",
    model: process.env.VISION_MODEL || process.env.VENICE_MODEL || "z-ai-glm-5v-turbo",
    provider: (process.env.VISION_PROVIDER as any) || "venice",
  };
}

export function isVisionConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.apiKey && cfg.apiUrl);
}

export interface MediaScore {
  assetId: string;
  score: number; // 0-100
  rank: number;
  reasons: string[];
}

export interface VisionAnalysisResult {
  scores: MediaScore[];
  topIds: string[];
  rawResponse: string;
  modelUsed: string;
}

const SYSTEM_PROMPT = `You are an expert sports photography evaluator for Girls In Sports (GIS), a youth sports camp and coaching clinic.

Your task: Analyze the provided camp media images and rank them from best to worst for MARKETING use.

Evaluate each image on these criteria (score 0-100):
1. **Composition** (20 pts): Rule of thirds, balance, leading lines, framing
2. **Action/Motion** (20 pts): Dynamic poses, peak action, movement blur (if intentional)
3. **Faces & Emotion** (20 pts): Visible faces, expressions of joy/effort/determination
4. **Lighting** (15 pts): Good exposure, no harsh shadows, golden hour bonus
5. **Relevance** (15 pts): Clearly shows the sport, camp atmosphere, teamwork
6. **Technical Quality** (10 pts): Sharp focus, no artifacts, proper color

For each image, provide:
- "assetId": the asset ID
- "score": 0-100
- "reasons": array of 2-3 brief strengths

Return ONLY a valid JSON array. No markdown, no explanations, no code blocks.

Example:
[
  {"assetId":"abc123","score":92,"reasons":["Peak action moment","Great facial expression","Strong composition"]},
  {"assetId":"def456","score":78,"reasons":["Good lighting","Motion blur adds dynamism"]}
]`;

function encodeImageToBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

const IMMICH_KEY = process.env.IMMICH_API_KEY || "";

async function fetchImageFromUrl(url: string): Promise<Buffer> {
  // Strip any ?key= query param from the URL — Immich ignores it and it
  // conflicts with the required x-api-key header on some endpoints.
  const cleanUrl = url.replace(/[?&]key=[^&]+/, "").replace(/\?$/, "");
  const res = await fetch(cleanUrl, {
    headers: {
      Accept: "image/*",
      "x-api-key": IMMICH_KEY,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function callVisionModel(
  config: VisionModelConfig,
  images: { assetId: string; base64: string; mimeType: string }[]
): Promise<VisionAnalysisResult> {
  const content: any[] = [
    {
      type: "text",
      text: `Analyze ${images.length} camp media images for marketing use. Rank from best to worst. Return JSON array with assetId, score (0-100), and reasons (2-3 strings).`,
    },
  ];

  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
    // Include assetId as text after each image for reference
    content.push({
      type: "text",
      text: `Image ID: ${img.assetId}`,
    });
  }

  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    max_tokens: 2000,
    temperature: 0.3,
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
    throw new Error(`Vision API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content || "";

  // Parse JSON from response
  let scores: MediaScore[] = [];
  try {
    // Strip markdown code blocks if present
    const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : rawContent;
    const parsed = JSON.parse(jsonStr);

    if (Array.isArray(parsed)) {
      scores = parsed
        .map((item: any, index: number) => ({
          assetId: String(item.assetId || ""),
          score: Math.min(100, Math.max(0, Number(item.score) || 0)),
          rank: index + 1,
          reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : [],
        }))
        .filter((s: MediaScore) => s.assetId && s.score > 0)
        .sort((a: MediaScore, b: MediaScore) => b.score - a.score)
        .map((s: MediaScore, i: number) => ({ ...s, rank: i + 1 }));
    }
  } catch (parseErr) {
    console.warn("Failed to parse vision response as JSON:", rawContent.substring(0, 500));
  }

  return {
    scores,
    topIds: scores.slice(0, 10).map((s) => s.assetId),
    rawResponse: rawContent,
    modelUsed: config.model,
  };
}

/**
 * Analyze media assets using a vision model.
 * Fetches images from Immich (via their URLs), sends to vision model, returns ranked scores.
 */
export async function analyzeMediaWithVision(
  assetUrls: { assetId: string; url: string }[],
  options?: {
    maxImages?: number; // Limit to avoid token overflow (default: 8)
    mimeType?: string;
  }
): Promise<VisionAnalysisResult> {
  const config = getConfig();

  if (!isVisionConfigured()) {
    throw new Error("Vision analysis not configured. Set VISION_API_URL and VISION_API_KEY.");
  }

  const maxImages = options?.maxImages || 8;
  const limitedUrls = assetUrls.slice(0, maxImages);

  // Fetch all images concurrently
  const images = await Promise.all(
    limitedUrls.map(async (item) => {
      try {
        const buffer = await fetchImageFromUrl(item.url);
        const base64 = encodeImageToBase64(buffer);
        return {
          assetId: item.assetId,
          base64,
          mimeType: options?.mimeType || "image/jpeg",
        };
      } catch (err) {
        console.warn(`Failed to fetch image for ${item.assetId}:`, err);
        return null;
      }
    })
  );

  const validImages = images.filter((img): img is NonNullable<typeof img> => img !== null);

  if (validImages.length === 0) {
    throw new Error("Failed to fetch any images for vision analysis");
  }

  return callVisionModel(config, validImages);
}

/**
 * Fallback: If vision model is unavailable, return assets in original order
 * with placeholder scores. This ensures the pipeline never blocks.
 */
export function fallbackRanking(assetIds: string[]): VisionAnalysisResult {
  return {
    scores: assetIds.map((id, i) => ({
      assetId: id,
      score: 50,
      rank: i + 1,
      reasons: ["Default ranking (vision model unavailable)"],
    })),
    topIds: assetIds.slice(0, 10),
    rawResponse: "Fallback: vision model not configured",
    modelUsed: "fallback",
  };
}
