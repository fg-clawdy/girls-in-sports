// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY TAGS — Event-aware context for AI scoring pipelines
//
// Maps ActivityTag enum values (from Prisma schema) to TypeScript types and
// Vision prompt context blocks so that scoring is event-aware rather than
// hardcoded around youth sports.
// ═══════════════════════════════════════════════════════════════════════════════

/** Canonical activity tag values (match Prisma ActivityTag enum case-insensitively) */
export type ActivityTag = "sports" | "party" | "play" | "speech";

/** Valid tag allowlist for runtime validation */
export const ACTIVITY_TAG_VALUES: ActivityTag[] = ["sports", "party", "play", "speech"];

/** Activity-to-context lookup: each tag maps to a paragraph that is injected
 *  into the Vision prompt to shape what counts as interesting for that event type. */
export const ACTIVITY_CONTEXT: Record<ActivityTag, string> = {
  sports: `SPORTS CONTEXT — This event is a youth sports activity (basketball, soccer, volleyball, etc.).
Look for: athletic action (shots, passes, blocks), team energy, coach encouragement, celebration after plays, hustle and effort, peak moments like goals or saves.
A high score means: peak sports action, clear emotion (joy, determination, celebration), a moment parents and teammates would want to relive.
A low score means: dead time between plays, people standing around, just walking or setting up.`,

  party: `PARTY CONTEXT — This event is a social celebration (birthday, graduation, team party, etc.).
Look for: candid laughter, group reactions, candid interactions between people, memorable moments (blowing out candles, opening gifts, dancing), emotional reactions and surprises.
A high score means: genuine joy, group energy, memorable celebration moments, interactions that capture the spirit of the event.
A low score means: people sitting around not doing much, empty shots of the room, repetitive or generic footage.`,

  play: `PLAY CONTEXT — This event is unstructured play or outdoor activity (recess, playground, pool, park, etc.).
Look for: spontaneous fun, kids being active and creative, peak moments of excitement (splashing, climbing, running), candid joy and freedom, interactions between children.
A high score means: genuine playful energy, spontaneous peak moments, clear emotion (laughter, excitement), moments that capture the joy of being a kid.
A low score means: static shots of equipment or scenery, kids just standing around, repetitive generic footage.`,

  speech: `SPEECH CONTEXT — This event features spoken content (keynote, coaching session, pep talk, instruction, interview, etc.).
Look for: passionate delivery, audience reactions, memorable lines, teaching moments, emotional peaks in speech delivery, impactful gestures or facial expressions during speaking.
A high score means: powerful delivery, clear emotion in the speaker or audience, memorable quotable moments, teaching or inspirational content.
A low score means: mumbling, off-camera audio with no visual, static shots of a speaker without engagement, dead air.`,
};

/** The generic base prompt that applies regardless of activity type. */
const BASE_PROMPT = `You are a video analyst for Girls In Sports (GIS).
Your task: For each temporal window (identified by its windowIndex), rate how EXCITING and INTERESTING the content is for a highlights reel.

A high score means: peak moments, clear emotion, something memorable happening, a moment people would want to see again.
A low score means: static/uneventful, nothing distinctive happening, dead time.`;

/** The scoring format and dimension instructions that always follow the activity context blocks. */
const SCORING_INSTRUCTIONS = `For each window, return:
- windowIndex (the number provided)
- interestingnessScore (0-100): rate the excitement and memorability of this window
- description (1 sentence describing what's happening in the video)
- hasAction (boolean: is there obvious movement, action, or activity?)
- hasEmotion (boolean: are faces visible showing joy, effort, celebration, or other strong emotion?)
- hasPeakMoment (boolean: is this a peak/critical moment — e.g. a goal, celebration, splash, surprise reaction, or memorable event?)

Return ONLY a valid JSON array. No markdown, no explanations.`;

/**
 * Build a Vision prompt string by combining BASE_PROMPT + activity context blocks + SCORING_INSTRUCTIONS.
 *
 * @param activityTags — zero or more activity tags describing the event type
 * @returns a complete system prompt string ready to send to the Vision API
 *
 * When activityTags is empty, returns BASE_PROMPT + SCORING_INSTRUCTIONS with no activity blocks.
 */
export function buildVisionPrompt(activityTags: ActivityTag[]): string {
  const parts: string[] = [BASE_PROMPT];

  // Normalize tags to lowercase and deduplicate
  const normalized = Array.from(new Set(activityTags.map((t) => t.toLowerCase() as ActivityTag)));

  for (const tag of normalized) {
    if (ACTIVITY_CONTEXT[tag]) {
      parts.push("\n" + ACTIVITY_CONTEXT[tag]);
    }
  }

  parts.push("\n" + SCORING_INSTRUCTIONS);
  return parts.join("\n");
}
