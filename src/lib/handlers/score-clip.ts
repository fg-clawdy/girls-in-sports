import { PrismaClient, AssetStatus, AssetTagSource, ClipType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { spawn } from "child_process";
import { promises as fs, readFileSync } from "fs";
import { join } from "path";
import { downloadAssetToFile, updateAssetDescription } from "../immich";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface ScoreClipPayload {
  assetId: string;
  immichAssetId: string;
  eventId: string;
  eventName?: string;
  parentJobId?: string | null;
}

const TMP_BASE = "/tmp/gis/score";

const VENICE_API_URL = process.env.VISION_API_URL || process.env.VENICE_API_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VISION_API_KEY || process.env.VENICE_API_KEY || "";
const VISION_MODEL = process.env.VISION_MODEL || "z-ai-glm-5v-turbo";

// Sport-specific keyword lists (configurable)
const SPORT_KEYWORDS: Record<string, string[]> = {
  basketball: ["shoot", "shot", "dribble", "pass", "block", "rebound", "defense", "hustle", "great", "nice shot", "let's go"],
  soccer: ["goal", "score", "pass", "kick", "save", "defense", "hustle", "great", "nice", "let's go"],
  volleyball: ["spike", "set", "dig", "block", "serve", "great", "hustle", "nice", "let's go"],
  default: ["great", "hustle", "defense", "let's go", "nice shot", "good job", "well done", "excellent", "amazing"],
};

export async function handleScoreClip(args: { payload: unknown; jobId: string }): Promise<void> {
  const pl = args.payload as ScoreClipPayload;
  const { assetId, immichAssetId, eventId } = pl;

  const tmpDir = join(TMP_BASE, assetId);
  await fs.mkdir(tmpDir, { recursive: true });
  const sourcePath = join(tmpDir, "source");

  try {
    // ── 1. Download clip from Immich ──
    await downloadAssetToFile(immichAssetId, sourcePath);
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { event: true },
    });
    if (!asset) throw new Error(`Asset ${assetId} not found`);

    const duration = asset.durationSeconds || 0;
    const sport = asset.event?.sport?.toLowerCase() || "default";

    // ── 2. Run STT on raw video ──
    const sttResult = await transcribeVideo(sourcePath);
    const { transcript, segments: sttSegments } = sttResult;

    // ── 3. Compute audio/keyword score ──
    const keywords = SPORT_KEYWORDS[sport] || SPORT_KEYWORDS.default;
    const { audioScore, keywordHits, hasCoachSpeech } = computeAudioScore(
      transcript,
      sttSegments,
      keywords
    );

    // ── 4. Extract keyframes ──
    const frameCount = duration <= 10 ? 3 : duration <= 30 ? 6 : 12;
    const framesDir = join(tmpDir, "frames");
    await fs.mkdir(framesDir, { recursive: true });
    const framePaths = await extractKeyframes(sourcePath, framesDir, frameCount, duration);

    // ── 5. Vision analysis on keyframes ──
    let visionScore = 0;
    let faceCount = 0;
    let hasFaces = false;
    let actionClarity = 0;
    let subjectCentering = 0;
    let brandVisibility = false;

    if (VENICE_API_KEY && framePaths.length > 0) {
      const visionResults = await analyzeKeyframesWithVision(framePaths, sport);
      visionScore = visionResults.overallScore;
      faceCount = visionResults.faceCount;
      hasFaces = faceCount > 0;
      actionClarity = visionResults.actionClarity;
      subjectCentering = visionResults.subjectCentering;
      brandVisibility = visionResults.brandVisibility;
    }

    // ── 6. Compute motion score locally ──
    const motionScore = await computeMotionScore(sourcePath);

    // ── 7. Composite score ──
    const composite = Math.round(
      visionScore * 0.50 + audioScore * 0.30 + motionScore * 0.20
    );

    // ── 8. Assign clipType ──
    const clipType = assignClipType(motionScore, audioScore);

    // ── 9. Create ClipScore record ──
    await prisma.clipScore.create({
      data: {
        assetId,
        visionScore: Math.round(visionScore),
        audioScore: Math.round(audioScore),
        motionScore: Math.round(motionScore),
        compositeScore: composite,
        clipType,
        hasFaces,
        hasCoachSpeech,
        hasActionKeyword: keywordHits.some((k) =>
          ["shoot", "shot", "goal", "score", "spike", "block", "save", "tackle"].includes(k)
        ),
        transcriptExcerpt: transcript.slice(0, 200),
        keywordHits: JSON.stringify(keywordHits),
      },
    });

    // ── 10. Update Asset status ──
    await prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.SCORED },
    });

    // ── 11. Write tags to Immich and AssetTag table ──
    const eventSport = asset.event?.sport || "sports";
    const tagDescription = [
      `gis:score=${composite}`,
      `gis:type=${clipType}`,
      `gis:sport=${eventSport}`,
      `gis:hasFaces=${hasFaces}`,
      `gis:hasCoachSpeech=${hasCoachSpeech}`,
    ].join("\n");

    await updateAssetDescription(immichAssetId, tagDescription);

    const tagsToWrite = [
      { tag: `score:${composite}`, confidence: 1.0 },
      { tag: `type:${clipType}`, confidence: 1.0 },
      { tag: `sport:${eventSport}`, confidence: 1.0 },
      ...(hasFaces ? [{ tag: "hasFaces", confidence: 1.0 }] : []),
      ...(hasCoachSpeech ? [{ tag: "hasCoachSpeech", confidence: 1.0 }] : []),
      ...keywordHits.map((k) => ({ tag: k, confidence: 0.8 })),
    ];

    for (const t of tagsToWrite) {
      await prisma.assetTag.upsert({
        where: {
          assetId_tag: { assetId, tag: t.tag },
        },
        update: { confidence: t.confidence, source: AssetTagSource.GIS_AI },
        create: {
          assetId,
          tag: t.tag,
          source: AssetTagSource.GIS_AI,
          confidence: t.confidence,
        },
      });
    }

    // ── 12. Set highest-scoring clip's best frame as Event thumbnail ──
    const eventAssets = await prisma.asset.findMany({
      where: { eventId, status: AssetStatus.SCORED },
      include: { clipScore: true },
    });
    const scoredAssets = eventAssets.filter((a) => a.clipScore);
    if (scoredAssets.length > 0) {
      const best = scoredAssets.reduce((max, a) =>
        (a.clipScore?.compositeScore || 0) > (max.clipScore?.compositeScore || 0) ? a : max
      );
      if (best.id === assetId) {
        await prisma.event.update({
          where: { id: eventId },
          data: { description: best.immichAssetId || undefined },
        });
      }
    }

    // ── 13. If all sibling clips are scored, set parent to SCORED and notify ──
    if (asset.parentAssetId) {
      const siblings = await prisma.asset.count({
        where: { parentAssetId: asset.parentAssetId, status: { not: AssetStatus.SCORED } },
      });
      if (siblings === 0) {
        await prisma.asset.update({
          where: { id: asset.parentAssetId },
          data: { status: AssetStatus.SCORED },
        });
      }
    }
  } finally {
    // ── 14. Clean up temp files ──
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ── STT: Extract audio then send to Venice /audio/transcriptions ──
async function transcribeVideo(videoPath: string): Promise<{
  transcript: string;
  segments: Array<{ start: number; end: number; text: string }>;
}> {
  // Extract audio to MP3 for reliable STT ingestion
  const audioPath = videoPath + ".mp3";
  await extractAudioToMp3(videoPath, audioPath);

  try {
    const buf = readFileSync(audioPath);
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mp3" }), "audio.mp3");
    form.append("model", "openai/whisper-large-v3");
    form.append("response_format", "json");

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

    // Venice json mode returns just text — create a single segment
    return {
      transcript: text,
      segments: text
        ? [{ start: 0, end: 0, text }]
        : [],
    };
  } finally {
    try {
      await fs.unlink(audioPath);
    } catch {
      // ignore cleanup
    }
  }
}

async function extractAudioToMp3(videoPath: string, audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-i", videoPath,
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-b:a", "32k",
      "-y",
      audioPath,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Audio extraction failed: ${stderr.slice(-500)}`));
    });
  });
}

// ── Audio score computation ──
function computeAudioScore(
  transcript: string,
  segments: Array<{ start: number; end: number; text: string }>,
  keywords: string[]
): { audioScore: number; keywordHits: string[]; hasCoachSpeech: boolean } {
  const lower = transcript.toLowerCase();
  const hits: string[] = [];
  let keywordCount = 0;

  for (const kw of keywords) {
    const regex = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = lower.match(regex);
    if (matches) {
      hits.push(kw);
      keywordCount += matches.length;
    }
  }

  // Speech density
  const totalSpeech = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const totalDuration = segments.length > 0 ? segments[segments.length - 1].end : 1;
  const density = Math.min(totalSpeech / Math.max(totalDuration, 1), 1);

  const keywordScore = Math.min(keywordCount * 8, 60);
  const densityBonus = density * 25;
  const score = Math.max(0, Math.min(100, keywordScore + densityBonus));

  // Coach speech heuristic: long continuous segments with directive words
  const hasCoachSpeech = segments.some(
    (s) => s.text.length > 20 && /(come on|let's|go to|move|position|defense|attack)/i.test(s.text)
  );

  return { audioScore: Math.round(score), keywordHits: hits, hasCoachSpeech };
}

// ── Keyframe extraction ──
async function extractKeyframes(
  videoPath: string,
  outputDir: string,
  count: number,
  duration: number
): Promise<string[]> {
  const paths: string[] = [];
  const interval = duration / (count + 1);

  for (let i = 1; i <= count; i++) {
    const time = interval * i;
    const outPath = join(outputDir, `frame_${i}.jpg`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-ss", time.toFixed(3),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "2",
        "-y",
        outPath,
      ]);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Keyframe extraction failed at ${time}s`));
      });
    });
    paths.push(outPath);
  }

  return paths;
}

// ── Vision analysis on keyframes (batched) ──
async function analyzeKeyframesWithVision(
  framePaths: string[],
  sport: string
): Promise<{
  overallScore: number;
  faceCount: number;
  actionClarity: number;
  subjectCentering: number;
  brandVisibility: boolean;
}> {
  const SYSTEM_PROMPT = `You are a sports photography evaluator for Girls In Sports.
Analyze the provided keyframes from a youth sports video clip.
Return ONLY a valid JSON object with these fields:
- energyScore (0-100): How energetic and dynamic the action is
- faceCount (int): Number of visible faces
- actionClarity (0-100): How clear the sports action is
- subjectCentering (0-100): How well subjects are framed
- brandVisibility (bool): Whether GIS branding/logos are visible
- overallScore (0-100): Overall quality for marketing use

Return ONLY the JSON object, no markdown, no explanations.`;

  // Read frames in batches of 3
  const batchSize = 3;
  const scores: number[] = [];
  let totalFaceCount = 0;
  let totalActionClarity = 0;
  let totalSubjectCentering = 0;
  let anyBrandVisible = false;

  for (let i = 0; i < framePaths.length; i += batchSize) {
    const batch = framePaths.slice(i, i + batchSize);
    const images = batch.map((p) => {
      const buf = readFileSync(p);
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    });

    const content: any[] = [
      { type: "text", text: `Analyze ${batch.length} keyframes from a ${sport} clip. Return JSON.` },
    ];
    for (const img of images) {
      content.push({ type: "image_url", image_url: { url: img } });
    }

    const res = await fetch(`${VENICE_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        max_tokens: 800,
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      console.warn(`Vision API error for batch ${i / batchSize}: ${res.status}`);
      continue;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      scores.push(Math.min(100, Math.max(0, Number(parsed.overallScore) || 50)));
      totalFaceCount += Math.max(0, Number(parsed.faceCount) || 0);
      totalActionClarity += Math.min(100, Math.max(0, Number(parsed.actionClarity) || 50));
      totalSubjectCentering += Math.min(100, Math.max(0, Number(parsed.subjectCentering) || 50));
      if (parsed.brandVisibility === true) anyBrandVisible = true;
    } catch (e) {
      console.warn("Failed to parse vision response:", raw.slice(0, 200));
      scores.push(50);
    }
  }

  const avgOverall = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 50;
  return {
    overallScore: Math.round(avgOverall),
    faceCount: totalFaceCount,
    actionClarity: Math.round(totalActionClarity / Math.max(scores.length, 1)),
    subjectCentering: Math.round(totalSubjectCentering / Math.max(scores.length, 1)),
    brandVisibility: anyBrandVisible,
  };
}

// ── Motion score via ffmpeg scene density ──
async function computeMotionScore(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-i", videoPath,
      "-vf", "select='gt(scene,0.05)',showinfo",
      "-an", "-f", "null", "-",
    ]);

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", () => {
      const timestamps: number[] = [];
      const regex = /pts_time:\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (!isNaN(t)) timestamps.push(t);
      }

      // Get duration for normalization
      const durProc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ]);
      let durOut = "";
      durProc.stdout.on("data", (d) => { durOut += d; });
      durProc.on("close", () => {
        const duration = parseFloat(durOut.trim()) || 1;
        const changesPerSecond = timestamps.length / duration;
        const score = Math.min(100, changesPerSecond * 100);
        resolve(Math.round(score));
      });
      durProc.on("error", () => resolve(50));
    });
    proc.on("error", () => resolve(50));
  });
}

// ── Clip type assignment ──
function assignClipType(motionScore: number, audioScore: number): ClipType {
  if (motionScore > 60 && audioScore < 40) return ClipType.ACTION;
  if (audioScore > 60 && motionScore < 40) return ClipType.SPEECH;
  if (motionScore > 60 && audioScore > 40) return ClipType.MIXED;
  return ClipType.MONTAGE;
}
