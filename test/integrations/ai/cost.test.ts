// Usage priced with the AI_PRICE_* settings (USD per million tokens): one token at $X/MTok is X micro-dollars, the four kinds add
// up, the result is a whole number of micro-dollars (assistant_turns.cost_micros) and never negative.
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_BEDROCK_MODELS,
  INTERIM_ASSISTANT_MODEL,
  TARGET_ASSISTANT_MODEL,
  addUsage,
  aiCostMicros,
  aiPricesFromEnv,
  findClaudeModel,
  resolveAiPrices,
} from '../../../src/integrations/ai/index.js'
import { loadEnv } from '../../../src/config/env.js'

const DB = { DATABASE_URL: 'postgres://oasis:x@127.0.0.1:5432/oasis' }
// Claude Sonnet 5.5 (the target model): round numbers for the arithmetic below
const prices = aiPricesFromEnv(loadEnv({ ...DB, AI_BEDROCK_MODEL_ID: TARGET_ASSISTANT_MODEL }))

describe('the prices: each AI_PRICE_* that is set, else the list price of the configured model', () => {
  it('defaults to the interim model, Claude Sonnet 4.6, at its list prices', () => {
    const env = loadEnv(DB)
    expect(env.AI_BEDROCK_MODEL_ID).toBe(INTERIM_ASSISTANT_MODEL)
    expect(INTERIM_ASSISTANT_MODEL).toBe('us.anthropic.claude-sonnet-4-6')
    expect(resolveAiPrices(env)).toEqual({
      prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
      source: 'model',
      model: 'us.anthropic.claude-sonnet-4-6',
    })
  })

  it('every listed model has its own list prices; switching the model is the one setting AI_BEDROCK_MODEL_ID', () => {
    const at = (id: string) => resolveAiPrices(loadEnv({ ...DB, AI_BEDROCK_MODEL_ID: id }))
    expect(at('us.anthropic.claude-sonnet-5-5')).toMatchObject({ source: 'model', prices: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 } })
    expect(at('us.anthropic.claude-opus-5-5')).toMatchObject({ source: 'model', prices: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 } })
    expect(at('us.anthropic.claude-sonnet-4-6')).toMatchObject({ source: 'model', prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } })
    expect(at('us.anthropic.claude-opus-4-6-v1')).toMatchObject({ source: 'model', prices: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 } })
    expect(at('us.anthropic.claude-opus-4-6-v1:0').model).toBe('us.anthropic.claude-opus-4-6-v1')
    for (const m of CLAUDE_BEDROCK_MODELS) {
      expect(findClaudeModel(m.profileId)).toBe(m)
      // the 5-minute cache write is 1.25 x input
      expect(m.prices.cacheWritePerMTok).toBeCloseTo(m.prices.inputPerMTok * 1.25, 10)
    }
  })

  it('a model the list does not know is priced at the highest listed rates, so the daily budget errs on the safe side', () => {
    expect(resolveAiPrices(loadEnv({ ...DB, AI_BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-9-9' }))).toEqual({
      prices: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
      source: 'highest',
    })
  })

  it('AI_PRICE_* override kind by kind (an empty line is unset); all four = the account rates only', () => {
    const all = { AI_PRICE_INPUT_PER_MTOK: '3.3', AI_PRICE_OUTPUT_PER_MTOK: '16.5', AI_PRICE_CACHE_READ_PER_MTOK: '0.33', AI_PRICE_CACHE_WRITE_PER_MTOK: '4.125' }
    expect(resolveAiPrices(loadEnv({ ...DB, ...all }))).toEqual({
      prices: { inputPerMTok: 3.3, outputPerMTok: 16.5, cacheReadPerMTok: 0.33, cacheWritePerMTok: 4.125 },
      source: 'env',
      model: 'us.anthropic.claude-sonnet-4-6',
    })
    expect(resolveAiPrices(loadEnv({ ...DB, AI_PRICE_OUTPUT_PER_MTOK: '20', AI_PRICE_CACHE_READ_PER_MTOK: '' }))).toMatchObject({
      prices: { inputPerMTok: 3, outputPerMTok: 20, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
      source: 'mixed',
    })
    expect(() => loadEnv({ ...DB, AI_PRICE_INPUT_PER_MTOK: '-1' })).toThrow(/AI_PRICE_INPUT_PER_MTOK/)
  })
})

describe('aiCostMicros', () => {
  it('prices each kind of token with its own rate', () => {
    expect(prices).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    })
    expect(
      aiCostMicros(
        { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        prices,
      ),
    ).toBe(2_000_000)
    expect(
      aiCostMicros({ inputTokens: 0, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }, prices),
    ).toBe(10_000)
    expect(
      aiCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0 }, prices),
    ).toBe(1) // 0.6 rounds up
    // a typical turn: 300 new input, 4,000 cached, 120 out -> 600 + 800 + 1,200 = 2,600 micro-dollars ($0.0026)
    expect(
      aiCostMicros(
        { inputTokens: 300, outputTokens: 120, cacheReadTokens: 4000, cacheWriteTokens: 0 },
        prices,
      ),
    ).toBe(2600)
    // the first call of the day writes the cache: 4,000 x 2.5
    expect(
      aiCostMicros(
        { inputTokens: 300, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 4000 },
        prices,
      ),
    ).toBe(11_800)
  })

  it('rounds half up once, ignores float noise, and never goes negative', () => {
    expect(
      aiCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 0 }, prices),
    ).toBe(1) // exactly 1.0
    expect(
      aiCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 7, cacheWriteTokens: 0 }, prices),
    ).toBe(1) // 1.4
    expect(
      aiCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 8, cacheWriteTokens: 0 }, prices),
    ).toBe(2) // 1.6
    expect(
      aiCostMicros(
        { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 0, cacheWriteTokens: 0 },
        prices,
      ),
    ).toBe(0)
    const custom = aiPricesFromEnv(
      loadEnv({
        ...DB,
        AI_BEDROCK_MODEL_ID: TARGET_ASSISTANT_MODEL,
        AI_PRICE_INPUT_PER_MTOK: '3',
        AI_PRICE_OUTPUT_PER_MTOK: '15',
      }),
    )
    expect(
      aiCostMicros({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, custom),
    ).toBe(1800)
  })

  it('adds the usage of the calls of one turn', () => {
    expect(
      addUsage(
        { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 },
        { inputTokens: 20, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 50 },
      ),
    ).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 200, cacheWriteTokens: 50 })
    expect(addUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
})
