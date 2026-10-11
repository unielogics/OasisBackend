// What one model call costs (ADR 0160): the usage a provider reports, priced with the AI_PRICE_* settings. A price is in US
// dollars per million tokens, so one token at $X/MTok costs exactly X micro-dollars: cost_micros (assistant_turns) is the sum of
// tokens x price over the four kinds, rounded once at the end. Bedrock reports input tokens WITHOUT the cached ones (cache reads
// and cache writes are their own counts), as the Anthropic API does, so nothing is counted twice.
import type { AiUsage } from '../ports/ai.js'
import type { AiEnvFragment } from './env.js'

/** US dollars per million tokens. */
export interface AiPrices {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

export type AiPriceEnv = Pick<
  AiEnvFragment,
  | 'AI_PRICE_INPUT_PER_MTOK'
  | 'AI_PRICE_OUTPUT_PER_MTOK'
  | 'AI_PRICE_CACHE_READ_PER_MTOK'
  | 'AI_PRICE_CACHE_WRITE_PER_MTOK'
>

export function aiPricesFromEnv(env: AiPriceEnv): AiPrices {
  return {
    inputPerMTok: env.AI_PRICE_INPUT_PER_MTOK,
    outputPerMTok: env.AI_PRICE_OUTPUT_PER_MTOK,
    cacheReadPerMTok: env.AI_PRICE_CACHE_READ_PER_MTOK,
    cacheWritePerMTok: env.AI_PRICE_CACHE_WRITE_PER_MTOK,
  }
}

const count = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** USD millionths for this usage, a non-negative integer (half up). */
export function aiCostMicros(usage: AiUsage, prices: AiPrices): number {
  const exact =
    count(usage.inputTokens) * prices.inputPerMTok +
    count(usage.outputTokens) * prices.outputPerMTok +
    count(usage.cacheReadTokens) * prices.cacheReadPerMTok +
    count(usage.cacheWriteTokens) * prices.cacheWritePerMTok
  // prices like 0.2 are not exact in binary: round away the float noise before the half-up rounding
  return Math.round(Math.round(exact * 1e6) / 1e6)
}

/** Sums the usage of several calls (one turn = up to five calls). */
export function addUsage(...all: AiUsage[]): AiUsage {
  return all.reduce<AiUsage>(
    (a, u) => ({
      inputTokens: a.inputTokens + count(u.inputTokens),
      outputTokens: a.outputTokens + count(u.outputTokens),
      cacheReadTokens: a.cacheReadTokens + count(u.cacheReadTokens),
      cacheWriteTokens: a.cacheWriteTokens + count(u.cacheWriteTokens),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
}
