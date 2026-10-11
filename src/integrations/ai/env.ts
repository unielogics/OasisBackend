import { z } from 'zod'

const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
const int = (min: number, max: number, dflt: number) => z.coerce.number().int().min(min).max(max).default(dflt)
/** USD per million tokens. */
const price = (dflt: number) => z.coerce.number().min(0).max(1000).default(dflt)

/**
 * The AI assistant's variables (ADR 0160, design section 1 "Env"), spread into envSchema (src/config/env.ts). Off and simulated by
 * default: AI_ENABLED=false answers nothing, AI_PROVIDER=sim never reaches AWS. The prices are Anthropic's first-party rates for
 * Claude Sonnet 5.5 (input $2, output $10, cache read $0.20, 5-minute cache write 1.25 x input); set the Bedrock rates of the
 * account before relying on the daily budget.
 */
export const aiEnvShape = {
  /** Master switch: the assistant answers texts only when true (with the settings assistant.enabled / stage on top). */
  AI_ENABLED: flag.default('false'),
  /** The in-chat book / reschedule / cancel tools (each still confirmed by a reply number); off = the AI sends a link instead. */
  AI_ACTIONS_ENABLED: flag.default('false'),
  AI_PROVIDER: z.enum(['sim', 'bedrock']).default('sim'),
  AI_BEDROCK_REGION: z.string().min(1).default('us-east-1'),
  /** The cross-region inference profile of Claude Sonnet 5.5 (owner decision 2026-10-10). */
  AI_BEDROCK_MODEL_ID: z.string().min(1).default('us.anthropic.claude-sonnet-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  /**
   * How AI_EFFORT reaches Bedrock: off (default: not sent, the model runs at its own default effort), output_config (Converse's
   * native outputConfig.effort) or additional_fields (additionalModelRequestFields.output_config.effort, the Anthropic request
   * field passed through). Off until pnpm verify:ai --probe-effort shows the account's model accepts it (ADR 0160, W2 notes).
   */
  AI_BEDROCK_EFFORT_MODE: z.enum(['off', 'output_config', 'additional_fields']).default('off'),
  AI_MAX_TOKENS: int(64, 4096, 800),
  /** One model call; the turn as a whole has AI_TURN_DEADLINE_MS. */
  AI_TIMEOUT_MS: int(1000, 120_000, 20_000),
  AI_TURN_DEADLINE_MS: int(5000, 300_000, 60_000),
  /** Quiet time after a text before the AI answers, so a burst of texts gets one answer. */
  AI_DEBOUNCE_MS: int(0, 60_000, 8000),
  AI_TURNS_PER_NUMBER_HOUR: int(1, 1000, 8),
  AI_TURNS_PER_NUMBER_DAY: int(1, 10_000, 25),
  /** A number with no client behind it. */
  AI_TURNS_UNKNOWN_DAY: int(1, 10_000, 10),
  AI_GLOBAL_TURNS_HOUR: int(1, 100_000, 100),
  AI_GLOBAL_TURNS_DAY: int(1, 1_000_000, 600),
  /** The AI's share of the tablet's 30-minute window (it never touches lane 0's reserve). */
  AI_SMS_SEGMENTS_PER_30MIN: int(0, 1000, 12),
  /** Spend of a day (business time zone) after which the AI stops answering and hands off. */
  AI_DAILY_BUDGET_USD: z.coerce.number().min(0).max(10_000).default(10),
  AI_PRICE_INPUT_PER_MTOK: price(2),
  AI_PRICE_OUTPUT_PER_MTOK: price(10),
  AI_PRICE_CACHE_READ_PER_MTOK: price(0.2),
  AI_PRICE_CACHE_WRITE_PER_MTOK: price(2.5),
}
export const aiEnvFragment = z.object(aiEnvShape)
export type AiEnvFragment = z.infer<typeof aiEnvFragment>
