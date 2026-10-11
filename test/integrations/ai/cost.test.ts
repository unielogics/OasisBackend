// Usage priced with the AI_PRICE_* settings (USD per million tokens): one token at $X/MTok is X micro-dollars, the four kinds add
// up, the result is a whole number of micro-dollars (assistant_turns.cost_micros) and never negative.
import { describe, expect, it } from 'vitest'
import { addUsage, aiCostMicros, aiPricesFromEnv } from '../../../src/integrations/ai/index.js'
import { loadEnv } from '../../../src/config/env.js'

const env = loadEnv({ DATABASE_URL: 'postgres://oasis:x@127.0.0.1:5432/oasis' })
const prices = aiPricesFromEnv(env)

describe('aiCostMicros', () => {
  it('prices each kind of token with its own rate (Sonnet 5.5 list prices by default)', () => {
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
        DATABASE_URL: 'postgres://oasis:x@127.0.0.1:5432/oasis',
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
