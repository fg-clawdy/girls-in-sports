// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO ANALYSIS — Extract audio from video, run STT via Venice.ai,
// score based on energy + keyword detection.
// ═══════════════════════════════════════════════════════════════════════════════

import { spawn } from "child_process";
import { mkdtemp, writeFile, readFile, unlink, rmdir } from "fs/promises";
import * as pathModule from "path";
import * as osModule from "os";

const path = pathModule;
const os = osModule;

const VENICE_API_URL = process.env.VISION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VISION_API_KEY || process.env.VENICE_API_KEY || "";

// Default STT model — swap to "stt-xai-v1" if whisper-large-v3 underperforms
const DEFAULT_STT_MODEL = "openai/whisper-large-v3";

export interface AudioAnalysisResult {
  assetId: string;
  transcript: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    confidence?: number;
  }>;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
  audioScore: number; // 0-100
  keywordHits: string[];
  keywordCount: number;
  error?: string;
}

/**
 * Extract audio from a local video file to a temporary WAV file.
 * Returns the path to the WAV file (caller must clean up).
 */
export async function extractAudioFromVideo(
  localVideoPath: string
): Promise<string> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gis-audio-"));
  const outPath = path.join(tmpDir, "audio.wav");

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", localVideoPath,
      "-vn", // no video
      "-acodec", "pcm_s16le",
      "-ar", "16000", // 16kHz — Whisper sweet spot
      "-ac", "1", // mono
      "-y",
      outPath,
    ]);
    ffmpeg.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg audio extraction failed: code ${code}`));
    });
    ffmpeg.on("error", reject);
  });

  return outPath;
}

/**
 * Parse Venice /audio/transcriptions response with timestamps=true.
 * Groups words into sentence-level segments for scene mapping.
 */
function parseTranscriptionResponse(data: any): {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: Array<{ word: string; start: number; end: number }>;
} {
  const text = (data.text || "").trim();

  // Venice nests word timestamps under response.timestamps.word
  // NOT response.words — this is a common pitfall.
  const rawWords = data.timestamps?.word || data.words || [];

  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    // Fallback: single segment with no timing
    return {
      text,
      segments: text ? [{ start: 0, end: 0, text }] : [],
      words: [],
    };
  }

  const words = rawWords.map((w: any) => ({
    word: String(w.word || "").trim(),
    start: Number(w.start ?? 0),
    end: Number(w.end ?? 0),
  })).filter((w: any) => w.word.length > 0);

  // Group words into segments (~8–12 words or pause > 1.5s)
  const segments: Array<{ start: number; end: number; text: string }> = [];
  let currentWords: typeof words = [];

  for (const w of words) {
    if (currentWords.length === 0) {
      currentWords.push(w);
      continue;
    }
    const last = currentWords[currentWords.length - 1];
    const pause = w.start - last.end;
    // Break on long pause or max segment length
    if (pause > 1.5 || currentWords.length >= 12) {
      segments.push({
        start: currentWords[0].start,
        end: last.end,
        text: currentWords.map((cw) => cw.word).join(" "),
      });
      currentWords = [w];
    } else {
      currentWords.push(w);
    }
  }

  if (currentWords.length > 0) {
    segments.push({
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
      text: currentWords.map((cw) => cw.word).join(" "),
    });
  }

  return { text, segments, words };
}

/**
 * Send audio file to Venice.ai STT API with timestamps=true.
 * Uses WAV (pcm_s16le 16kHz mono) for best compatibility.
 * Returns transcript + segments + word-level timestamps.
 *
 * DEPRECATED path: if Venice returns no words array (e.g. service degraded),
 * falls back to single-segment mode. The old verbose_json path is kept
 * in the codebase but not used — remove after Venice transcription GA.
 */
export async function transcribeWithVenice(
  audioPath: string,
  model: string = DEFAULT_STT_MODEL
): Promise<{
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: Array<{ word: string; start: number; end: number }>;
}> {
  const audioBuffer = await readFile(audioPath);

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
  formData.append("model", model);
  formData.append("response_format", "json");
  // FormData values are always strings; "true" is the standard encoding
  // for a boolean in multipart/form-data and Venice parses it correctly.
  formData.append("timestamps", "true");

  const res = await fetch(`${VENICE_API_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VENICE_API_KEY}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STT failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return parseTranscriptionResponse(data);
}

// Keywords that indicate high-energy, marketable moments
const POSITIVE_KEYWORDS = [
  // English
  "goal", "score", "yes", "yeah", "go", "nice", "great", "awesome", "perfect",
  " hustle", "dig", "push", "drive", "attack", "fire", "let's go",
  "good job", "well done", "excellent", "amazing", "incredible",
  "cheer", "cheering", "applause", "clapping",
  // Sports-specific
  "shoot", "shot", "pass", "dribble", "catch", "throw", "swing", "kick",
  "run", "sprint", "block", "tackle", "save",
  // Coaching
  "coach", "instruction", "drill", "practice", "training",
];

const NEGATIVE_KEYWORDS = [
  "quiet", "silence", "shh", "stop", "hold", "wait",
  "um", "uh", "background noise",
];

/**
 * Compute an audio quality score (0-100) from transcript + segments.
 */
export function computeAudioScore(
  transcript: string,
  segments: Array<{ start: number; end: number; text: string }>
): { score: number; keywordHits: string[]; keywordCount: number } {
  const lowerText = transcript.toLowerCase();
  const keywordHits: string[] = [];
  let keywordCount = 0;

  for (const kw of POSITIVE_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = lowerText.match(regex);
    if (matches) {
      keywordHits.push(kw);
      keywordCount += matches.length;
    }
  }

  // Speech density: how much of the video has spoken content
  const totalSpeechDuration = segments.reduce(
    (sum, s) => sum + (s.end - s.start),
    0
  );
  // Assume total duration is the last segment end, or fallback
  const totalDuration = segments.length > 0 ? segments[segments.length - 1].end : 1;
  const speechDensity = Math.min(totalSpeechDuration / Math.max(totalDuration, 1), 1);

  // Base score from keyword richness
  const keywordScore = Math.min(keywordCount * 8, 60); // cap at 60

  // Density bonus: clips with more continuous speech score higher
  const densityBonus = speechDensity * 25; // 0-25

  // Penalize negative keywords
  let penalty = 0;
  for (const kw of NEGATIVE_KEYWORDS) {
    if (lowerText.includes(kw)) penalty += 5;
  }

  const score = Math.max(0, Math.min(100, keywordScore + densityBonus - penalty));

  return { score: Math.round(score), keywordHits, keywordCount };
}

/**
 * Full pipeline: extract audio → STT → score.
 * Returns AudioAnalysisResult. Caller must clean up video file.
 */
export async function analyzeVideoAudio(
  localVideoPath: string,
  assetId: string,
  model?: string
): Promise<AudioAnalysisResult> {
  let audioPath: string | null = null;

  try {
    audioPath = await extractAudioFromVideo(localVideoPath);
    const { text, segments, words } = await transcribeWithVenice(audioPath, model);
    const { score, keywordHits, keywordCount } = computeAudioScore(text, segments);

    return {
      assetId,
      transcript: text,
      segments,
      words,
      audioScore: score,
      keywordHits,
      keywordCount,
    };
  } catch (err: any) {
    return {
      assetId,
      transcript: "",
      segments: [],
      words: [],
      audioScore: 0,
      keywordHits: [],
      keywordCount: 0,
      error: err instanceof Error ? err.message : "Audio analysis failed",
    };
  } finally {
    // Clean up temp audio file and its directory
    if (audioPath) {
      try {
        await unlink(audioPath);
        await rmdir(path.dirname(audioPath)).catch(() => {});
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
