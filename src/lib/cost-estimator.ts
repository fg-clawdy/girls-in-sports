/**
 * Estimate DIEM cost for Venice.ai API operations.
 * Fallback since billing API is not accessible with inference keys.
 */

// Venice pricing approximations (DIEM per 1K tokens)
const PRICING = {
  textInput: 0.0001,
  textOutput: 0.0003,
  visionPerImage: 0.015, // per image/frame in vision batch
};

function estimateTokens(text: string): number {
  // Rough estimate: ~1 token per 4 characters for English
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
