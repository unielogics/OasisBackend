// What one model call costs (ADR 0160): the usage a provider reports, priced with the AI_PRICE_* settings (each one unset = the
// list price of the configured model, src/integrations/ai/models.ts). A price is in US
// dollars per million tokens, so one token at $X/MTok costs exactly X micro-dollars: cost_micros (assistant_turns) is the sum of
// tokens x price over the four kinds, rounded once at the end. Bedrock reports input tokens WITHOUT the cached ones (cache reads
// and cache writes are their own counts), as the Anthropic API does, so nothing is counted twice.
import type { AiUsage } from '../ports/ai.js'
import type { AiEnvFragment } from './env.js'
import { findClaudeModel, highestListPrices } from './models.js'

/** US dollars per million tokens. */
export interface AiPrices {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

export type AiPriceEnv = Pick<
  AiEnvFragment,
  | 'AI_BEDROCK_MODEL_ID'
  | 'AI_PRICE_INPUT_PER_MTOK'
  | 'AI_PRICE_OUTPUT_PER_MTOK'
  | 'AI_PRICE_CACHE_READ_PER_MTOK'
  | 'AI_PRICE_CACHE_WRITE_PER_MTOK'
>

/**
 * Where the prices came from: every AI_PRICE_* set ('env'), the list prices of the configured model ('model'), some of each
 * ('mixed'), or, for a model models.ts does not list and no AI_PRICE_* set, the highest listed prices ('highest': a budget that
 * errs on the safe side).
 */
export type AiPriceSource = 'env' | 'model' | 'mixed' | 'highest'

export interface ResolvedAiPrices {
  prices: AiPrices
  source: AiPriceSource
  /** The listed model whose prices are the defaults (undefined when it is not listed). */
  model?: string
}

/** The prices cost_micros uses: each AI_PRICE_* that is set, else the configured model's list price (models.ts). */
export function resolveAiPrices(env: AiPriceEnv): ResolvedAiPrices {
  const listed = findClaudeModel(env.AI_BEDROCK_MODEL_ID)
  const base = listed?.prices ?? highestListPrices()
  const set = {
    inputPerMTok: env.AI_PRICE_INPUT_PER_MTOK,
    outputPerMTok: env.AI_PRICE_OUTPUT_PER_MTOK,
    cacheReadPerMTok: env.AI_PRICE_CACHE_READ_PER_MTOK,
    cacheWritePerMTok: env.AI_PRICE_CACHE_WRITE_PER_MTOK,
  }
  const given = Object.values(set).filter((v) => v !== undefined).length
  const prices: AiPrices = {
    inputPerMTok: set.inputPerMTok ?? base.inputPerMTok,
    outputPerMTok: set.outputPerMTok ?? base.outputPerMTok,
    cacheReadPerMTok: set.cacheReadPerMTok ?? base.cacheReadPerMTok,
    cacheWritePerMTok: set.cacheWritePerMTok ?? base.cacheWritePerMTok,
  }
  const source: AiPriceSource = given === 4 ? 'env' : given > 0 ? 'mixed' : listed ? 'model' : 'highest'
  return { prices, source, ...(listed ? { model: listed.profileId } : {}) }
}

export function aiPricesFromEnv(env: AiPriceEnv): AiPrices {
  return resolveAiPrices(env).prices
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
