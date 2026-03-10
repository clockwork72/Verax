export type TextSizeUnit = 'tokens' | 'words' | 'chars' | 'kb'

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  // Local DeepSeek HPC — no remote cost
  'openai/local': { input: 0, output: 0 },
  'local': { input: 0, output: 0 },
}

export type AnnotationUsage = {
  tokensIn: number
  tokensOut: number
}

function parseDoneUsage(line: string): AnnotationUsage {
  const done = line.match(/\|\s*([\d,]+)↑\/([\d,]+)↓/)
  if (!done) return { tokensIn: 0, tokensOut: 0 }
  return {
    tokensIn: Number(done[1].replace(/,/g, '')) || 0,
    tokensOut: Number(done[2].replace(/,/g, '')) || 0,
  }
}

export function pricingForModel(model: string): { input: number; output: number } {
  return MODEL_PRICING[model] ?? MODEL_PRICING['gpt-4o-mini']
}

export function parseAnnotationDoneUsage(logs: string[]): AnnotationUsage {
  let tokensIn = 0
  let tokensOut = 0
  for (const line of logs) {
    const usage = parseDoneUsage(line)
    tokensIn += usage.tokensIn
    tokensOut += usage.tokensOut
  }
  return { tokensIn, tokensOut }
}

export function parseAnnotationUsage(logs: string[]): AnnotationUsage {
  let tokensIn = 0
  let tokensOut = 0

  for (const line of logs) {
    const doneUsage = parseDoneUsage(line)
    if (doneUsage.tokensIn || doneUsage.tokensOut) {
      tokensIn += doneUsage.tokensIn
      tokensOut += doneUsage.tokensOut
      continue
    }

    // Optional future summary line:
    // [usage] prompt_tokens=... completion_tokens=...
    const usage = line.match(/prompt_tokens\s*=\s*([\d,]+).*completion_tokens\s*=\s*([\d,]+)/i)
    if (usage) {
      tokensIn = Math.max(tokensIn, Number(usage[1].replace(/,/g, '')) || 0)
      tokensOut = Math.max(tokensOut, Number(usage[2].replace(/,/g, '')) || 0)
    }
  }

  return { tokensIn, tokensOut }
}

export function estimateTokens(sizeValue: number, unit: TextSizeUnit): number {
  const v = Math.max(0, sizeValue)
  if (unit === 'tokens') return Math.round(v)
  if (unit === 'words') return Math.round(v * 1.33)
  if (unit === 'kb') return Math.round((v * 1024) / 4)
  return Math.round(v / 4) // chars
}

type CostBand = {
  inputTokens: number
  outputTokens: number
  usd: number
}

export type AnnotationCostEstimate = {
  inputTokens: number
  chunkCount: number
  low: CostBand
  typical: CostBand
  high: CostBand
}

export function estimateAnnotationCost(options: {
  model: string
  textSizeValue: number
  textSizeUnit: TextSizeUnit
  tokenLimit?: number
  disableExhaustionCheck?: boolean
}): AnnotationCostEstimate {
  const tokenLimit = Math.max(100, options.tokenLimit ?? 500)
  const inputTokens = Math.max(1, estimateTokens(options.textSizeValue, options.textSizeUnit))

  // Chunking in preprocessing includes contextual overlap; effective new content per chunk is < tokenLimit.
  const effectivePerChunk = Math.max(120, Math.round(tokenLimit * 0.78))
  const chunkCount = Math.max(1, Math.ceil(inputTokens / effectivePerChunk))

  // Heuristics calibrated for this pipeline:
  // - Large system prompt + chunk text dominates prompt tokens.
  // - Reflection rounds add prompt overhead.
  // - Optional exhaustion checks add extra calls.
  const exhaustionCallsPerChunk = options.disableExhaustionCheck ? 0 : 0.45

  const lowPrompt = Math.round(inputTokens * 2.1 + chunkCount * (700 + Math.round(exhaustionCallsPerChunk * 350)))
  const midPrompt = Math.round(inputTokens * 3.0 + chunkCount * (950 + Math.round(exhaustionCallsPerChunk * 500)))
  const highPrompt = Math.round(inputTokens * 4.2 + chunkCount * (1300 + Math.round(exhaustionCallsPerChunk * 700)))

  const lowOut = Math.round(inputTokens * 0.16)
  const midOut = Math.round(inputTokens * 0.28)
  const highOut = Math.round(inputTokens * 0.45)

  const rates = pricingForModel(options.model)
  const usd = (inTok: number, outTok: number) => (inTok / 1_000_000) * rates.input + (outTok / 1_000_000) * rates.output

  return {
    inputTokens,
    chunkCount,
    low: { inputTokens: lowPrompt, outputTokens: lowOut, usd: usd(lowPrompt, lowOut) },
    typical: { inputTokens: midPrompt, outputTokens: midOut, usd: usd(midPrompt, midOut) },
    high: { inputTokens: highPrompt, outputTokens: highOut, usd: usd(highPrompt, highOut) },
  }
}

export function formatUsd(value: number, digits = 4): string {
  return `$${value.toFixed(digits)}`
}
