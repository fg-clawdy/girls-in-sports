// Model-agnostic chat completion for GIS AI Assistant
// Provides composition guidance with event context

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

interface ChatContext {
  eventName: string;
  sport: string;
  city: string;
  eventDate: string;
  selectedCount: number;
  outputType?: string;
  previousResults?: string[];
}

function getConfig(): ChatConfig | null {
  const apiUrl = process.env.CHAT_API_URL || process.env.VISION_API_URL || "";
  const apiKey = process.env.CHAT_API_KEY || process.env.VISION_API_KEY || "";
  const model = process.env.CHAT_MODEL || process.env.VISION_MODEL || "";

  if (!apiUrl || !apiKey) return null;
  return { apiUrl, apiKey, model };
}

export function isChatConfigured(): boolean {
  return getConfig() !== null;
}

const SYSTEM_PROMPT = `You are the Girls In Sports AI Composition Assistant. You help sports camp directors and coaches create compelling marketing content from their event photos and videos.

Your expertise includes:
- Sports photography composition (rule of thirds, leading lines, capturing peak action)
- Video editing for highlight reels (pacing, music sync, storytelling)
- Marketing psychology for youth sports (emotion, energy, community)
- Social media optimization (aspect ratios, text placement, hooks)

Brand guidelines for Girls In Sports:
- Primary: Red (#D13B3B), Navy (#1E3A5F), Gold (#F4C542)
- Secondary: White, Light Gray
- Tone: Empowering, energetic, inclusive, professional
- Target audience: Parents, young athletes, coaches, sponsors

When giving advice:
- Be specific and actionable
- Reference the actual media the user has selected
- Suggest improvements to composition, captions, or clip order
- Keep responses concise (2-4 sentences per point)
- Use bullet points for multiple suggestions`;

export async function sendChatMessage(
  message: string,
  history: ChatMessage[],
  context: ChatContext
): Promise<{ response: string; modelUsed: string }> {
  const config = getConfig();
  if (!config) {
    return {
      response: "Chat assistant is not configured. Please set CHAT_API_URL and CHAT_API_KEY in your environment.",
      modelUsed: "none",
    };
  }

  const contextStr = `
Event: ${context.eventName} (${context.sport}) in ${context.city} on ${context.eventDate}
Selected media: ${context.selectedCount} items
${context.outputType ? `Output type: ${context.outputType}` : ""}
${context.previousResults?.length ? `Previous compositions: ${context.previousResults.join(", ")}` : ""}
`;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + "\n\nCurrent context:\n" + contextStr },
    ...history,
    { role: "user", content: message },
  ];

  const res = await fetch(`${config.apiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const response = data.choices?.[0]?.message?.content || "No response from assistant.";
  const modelUsed = data.model || config.model;

  return { response, modelUsed };
}

export type { ChatMessage, ChatContext };
