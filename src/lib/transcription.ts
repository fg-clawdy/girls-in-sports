// ═══════════════════════════════════════════════════════════════════════════════
// SHARED TRANSCRIPTION MODULE (S1-02 / S1-03)
// Dual-path: Venice /audio/transcriptions with diarization primary,
// fallback to standard Whisper.  Used by both ingest-clip and score-clip.
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync } from "fs";
import { promises as fs } from "fs";
import { spawn } from "child_process";

const VENICE_API_URL = process.env.VISION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VISION_API_KEY || process.env.VENICE_API_KEY || "";

export interface TranscriptionResult {
  transcript: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: Array<{ word: string; start: number; end: number }>;
  speakerSegments: Array<{ speakerLabel: string; start: number; end: number; text: string }>;
  provider: "venice-beta" | "whisper-fallback";
  fallbackReason?: string;
}

export async function transcribeVideo(videoPath: string): Promise<TranscriptionResult> {
  const audioPath = videoPath + ".wav";
  await extractAudioToWav(videoPath, audioPath);

  try {
    const primary = await tryTranscribe(audioPath, { diarize: true });
    if (primary.speakerSegments.length > 0) {
      return { ...primary, provider: "venice-beta" };
    }
    const fallback = await tryTranscribe(audioPath, { diarize: false });
    return {
      ...fallback,
      provider: "whisper-fallback",
      fallbackReason: "diarization_unavailable",
    };
  } finally {
    try { await fs.unlink(audioPath); } catch { /* ignore */ }
  }
}

async function tryTranscribe(
  audioPath: string,
  opts: { diarize: boolean }
): Promise<Omit<TranscriptionResult, "provider" | "fallbackReason">> {
  const buf = readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  form.append("model", "openai/whisper-large-v3");
  form.append("response_format", "json");
  form.append("timestamps", "true");
  if (opts.diarize) {
    form.append("diarize", "true");
    form.append("diarize_audio", "true");
  }

  const res = await fetch(`${VENICE_API_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${VENICE_API_KEY}` },
    body: form as any,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STT failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const text = data.text || "";
  const rawWords = data.timestamps?.word || data.words || [];

  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    return {
      transcript: text,
      segments: text ? [{ start: 0, end: 0, text }] : [],
      words: [],
      speakerSegments: [],
    };
  }

  const words = rawWords.map((w: any) => ({
    word: String(w.word || "").trim(),
    start: Number(w.start ?? 0),
    end: Number(w.end ?? 0),
  })).filter((w: any) => w.word.length > 0);

  // Group words into sentence segments
  const segments: Array<{ start: number; end: number; text: string }> = [];
  let currentWords: typeof words = [];

  for (const w of words) {
    if (currentWords.length === 0) { currentWords.push(w); continue; }
    const last = currentWords[currentWords.length - 1];
    const pause = w.start - last.end;
    if (pause > 1.5 || currentWords.length >= 12) {
      segments.push({
        start: currentWords[0].start,
        end: last.end,
        text: currentWords.map((cw: any) => cw.word).join(" "),
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
      text: currentWords.map((cw: any) => cw.word).join(" "),
    });
  }

  // Extract speaker segments from diarization response (if present)
  const speakerSegments: Array<{ speakerLabel: string; start: number; end: number; text: string }> = [];
  const rawSpeakers = data.speakers || data.segments || data.diarization || [];
  if (Array.isArray(rawSpeakers) && rawSpeakers.length > 0) {
    for (const s of rawSpeakers) {
      const label = String(s.speaker || s.speaker_id || s.label || "UNKNOWN").trim();
      const start = Number(s.start ?? s.start_time ?? 0);
      const end = Number(s.end ?? s.end_time ?? 0);
      const segText = String(s.text || s.transcript || "").trim();
      if (segText) {
        speakerSegments.push({ speakerLabel: label, start, end, text: segText });
      }
    }
  }

  // Coach-speaker heuristic fallback
  if (speakerSegments.length === 0 && segments.length > 0) {
    for (const seg of segments) {
      const isCoach = seg.text.length > 20 && /(come on|let's|go to|move|position|defense|attack|hustle|set up|spread out)/i.test(seg.text);
      speakerSegments.push({
        speakerLabel: isCoach ? "coach" : "unknown",
        start: seg.start,
        end: seg.end,
        text: seg.text,
      });
    }
  }

  return { transcript: text, segments, words, speakerSegments };
}

async function extractAudioToWav(videoPath: string, audioPath: string): Promise<void> {
  const AUDIO_TIMEOUT_MS = 300_000;
  return new Promise((resolve, reject) => {
    const proc = spawn("nice", ["-n", "10", "ffmpeg", ...[
      "-i", videoPath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", audioPath,
    ]]);
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Audio extraction timed out after ${AUDIO_TIMEOUT_MS}ms`));
    }, AUDIO_TIMEOUT_MS);
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Audio extraction failed: ${stderr.slice(-500)}`));
    });
  });
}
