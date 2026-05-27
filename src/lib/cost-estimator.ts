import { prisma } from "./prisma";
import { getEnv } from "./env";

const PRICING = {
  textInput: 0.0001,
  textOutput: 0.0003,
  visionPerImage: 0.015,
  sttPerMinute: 0.005,
  musicGen: 0.10,
  upscalePerClip: 0.08,
  // S1-06: AI interestingness pricing
  interestingnessPerWindowFrames: 3,    // frames per window (3 vision images per window)
  quoteQualityPerCall: 0.002,          // ~0.002 DIEM per quote analysis (text LLM call)
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CostEstimate {
  textTokens: number;
  visionFrames: number;
  estimatedDIEM: number;
}

/**
 * Estimate cost for composition generation (text LLM call).
 */
export function estimateCompositionCost(
  input: { event: any; assets: any[]; outputType: string; userIntent?: string }
): CostEstimate {
  const promptText = JSON.stringify(input);
  const tokens = estimateTokens(promptText);
  // Assume output is roughly half the input length in tokens
  const inputCost = (tokens / 1000) * PRICING.textInput;
  const outputCost = (tokens / 2000) * PRICING.textOutput;
  const estimatedDIEM = inputCost + outputCost;

  return {
    textTokens: tokens,
    visionFrames: 0,
    estimatedDIEM: parseFloat(estimatedDIEM.toFixed(6)),
  };
}

/**
 * Estimate cost for vision batch ranking.
 */
export function estimateVisionCost(frameCount: number): CostEstimate {
  const estimatedDIEM = frameCount * PRICING.visionPerImage;
  return {
    textTokens: 0,
    visionFrames: frameCount,
    estimatedDIEM: parseFloat(estimatedDIEM.toFixed(6)),
  };
}

/**
 * Total pipeline cost: vision ranking + composition generation.
 */
export function estimateTotalPipelineCost(
  compositionInput: Parameters<typeof estimateCompositionCost>[0],
  frameCount: number
): CostEstimate {
  const comp = estimateCompositionCost(compositionInput);
  const vis = estimateVisionCost(frameCount);
  return {
    textTokens: comp.textTokens,
    visionFrames: vis.visionFrames,
    estimatedDIEM: parseFloat((comp.estimatedDIEM + vis.estimatedDIEM).toFixed(6)),
  };
}

/**
 * Should we generate a second A/B variant?
 * Threshold: ≤ 1 DIEM for the first composition.
 */
export function shouldGenerateABVariant(costDIEM: number): boolean {
  return costDIEM < 1.0;
}

export function estimateDirectScriptCost(clipCount: number, hasIntent: boolean): CostEstimate {
  const base = clipCount * 1200;
  const intentExtra = hasIntent ? 800 : 0;
  const tokens = base + intentExtra;
  const inputCost = (tokens / 1000) * PRICING.textInput;
  const outputCost = (tokens / 1500) * PRICING.textOutput;
  return { textTokens: tokens, visionFrames: 0, estimatedDIEM: parseFloat((inputCost + outputCost).toFixed(6)) };
}

export function estimateScoreClipCost(hasVision: boolean, hasSTT: boolean, durationSec: number): CostEstimate {
  let d = 0;
  if (hasVision) d += 3 * PRICING.visionPerImage;
  if (hasSTT) d += Math.max(0.001, (durationSec / 60) * PRICING.sttPerMinute);
  // S1-06: Add AI interestingness estimation
  const numWindows = Math.min(40, Math.ceil(durationSec / 8));
  if (hasVision && numWindows > 0) {
    d += numWindows * PRICING.interestingnessPerWindowFrames * PRICING.visionPerImage;
  }
  // Quote quality (text LLM call) — only if transcript exists
  d += PRICING.quoteQualityPerCall;
  return { textTokens: 0, visionFrames: hasVision ? 3 : 0, estimatedDIEM: parseFloat(d.toFixed(6)) };
}

export function estimateMusicGenCost(): CostEstimate {
  return { textTokens: 0, visionFrames: 0, estimatedDIEM: PRICING.musicGen };
}

export function estimateUpscaleCost(): CostEstimate {
  return { textTokens: 0, visionFrames: 0, estimatedDIEM: PRICING.upscalePerClip };
}

/**
 * S1-06: Estimate cost specifically for temporal interestingness analysis.
 * Used for standalone pricing when interestingness is run independently.
 */
export function estimateInterestingnessCost(durationSec: number): CostEstimate {
  const numWindows = Math.min(40, Math.max(1, Math.ceil(durationSec / 8)));
  const visionFrames = numWindows * PRICING.interestingnessPerWindowFrames;
  const d = visionFrames * PRICING.visionPerImage + PRICING.quoteQualityPerCall;
  return {
    textTokens: 0,
    visionFrames,
    estimatedDIEM: parseFloat(d.toFixed(6)),
  };
}

const circuitBreakers = new Map<string, { fails: number; pausedUntil: number }>();

export function isEventCircuitPaused(eventId: string): boolean {
  const b = circuitBreakers.get(eventId);
  if (!b) return false;
  if (Date.now() > b.pausedUntil) { circuitBreakers.delete(eventId); return false; }
  return true;
}

export function recordJobOutcome(eventId: string, success: boolean): void {
  const now = Date.now();
  let b = circuitBreakers.get(eventId) || { fails: 0, pausedUntil: 0 };
  if (success) {
    b.fails = 0;
    b.pausedUntil = 0;
  } else {
    b.fails++;
    if (b.fails >= 3) b.pausedUntil = now + 10 * 60 * 1000;
  }
  circuitBreakers.set(eventId, b);
}

export async function checkAndReserveBudget(eventId: string, projectedUSD: number): Promise<{ allowed: boolean; effectiveBudget: number; current: number; reason?: string }> {
  const env = getEnv();
  const ev = await prisma.event.findUnique({ where: { id: eventId }, select: { costBudgetUSD: true, currentEstimatedCost: true } });
  if (!ev) return { allowed: false, effectiveBudget: 0, current: 0, reason: "Event not found" };
  const budget = ev.costBudgetUSD ?? env.DEFAULT_EVENT_BUDGET_USD;
  const current = ev.currentEstimatedCost ?? 0;
  if (current + projectedUSD > budget) {
    return { allowed: false, effectiveBudget: budget, current, reason: `Projected ${projectedUSD.toFixed(2)} would exceed budget ${budget.toFixed(2)} (current ${current.toFixed(2)})` };
  }
  await prisma.event.update({ where: { id: eventId }, data: { currentEstimatedCost: { increment: projectedUSD } } });
  return { allowed: true, effectiveBudget: budget, current: current + projectedUSD };
}

export async function refundBudget(eventId: string, amount: number): Promise<void> {
  await prisma.event.update({ where: { id: eventId }, data: { currentEstimatedCost: { decrement: Math.max(0, amount) } } });
}