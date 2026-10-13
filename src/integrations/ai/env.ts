import { z } from 'zod'
import { INTERIM_ASSISTANT_MODEL } from './models.js'

const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
const int = (min: number, max: number, dflt: number) => z.coerce.number().int().min(min).max(max).default(dflt)
/** USD per million tokens; unset = the list price of AI_BEDROCK_MODEL_ID (src/integrations/ai/models.ts). */
const price = () => z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(1000).optional())

/**
 * The AI assistant's variables (ADR 0160, design section 1 "Env"), spread into envSchema (src/config/env.ts). Off and simulated by
 * default: AI_ENABLED=false answers nothing, AI_PROVIDER=sim never reaches AWS. The AI_PRICE_* are unset by default: cost_micros
 * then uses the list prices of the configured model (models.ts; the highest listed ones for a model not in the list); set the
 * Bedrock rates of the account before relying on the daily budget.
 */
export const aiEnvShape = {
  /** Master switch: the assistant answers texts only when true (with the settings assistant.enabled / stage on top). */
  AI_ENABLED: flag.default('false'),
  /** The in-chat book / reschedule / cancel tools (each still confirmed by a reply number); off = the AI sends a link instead. */
  AI_ACTIONS_ENABLED: flag.default('false'),
  AI_PROVIDER: z.enum(['sim', 'bedrock']).default('sim'),
  AI_BEDROCK_REGION: z.string().min(1).default('us-east-1'),
  /**
   * The cross-region inference profile the assistant calls: Claude Sonnet 4.6 for now (owner 2026-10-11: the Claude 5.x quota of
   * the account is 0); us.anthropic.claude-sonnet-5-5 once it is raised. Every model of models.ts is in the IAM grant.
   */
  AI_BEDROCK_MODEL_ID: z.string().min(1).default(INTERIM_ASSISTANT_MODEL),
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
  /**
   * The output guard's policy judge (ADR 0160, design section 3c): one extra model call that reads every reply before it goes out.
   * Unset = on whenever AI_ENABLED is; false switches it off (the replies then go out after the deterministic checks only).
   */
  AI_GUARD_JUDGE: flag.optional(),
  /** The judge's model (a cross-region profile of models.ts); unset = AI_BEDROCK_MODEL_ID. */
  AI_GUARD_MODEL_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  /**
   * ADR 0174: the characters the owner's knowledge (active notes, documents and corrections) and the Settings Q&A may hold together
   * in the prompt (about 5k tokens at 20,000). A save that would go over it is refused (422 KNOWLEDGE_BUDGET); nothing is cut.
   */
  AI_KNOWLEDGE_MAX_CHARS: int(2000, 40_000, 20_000),
  /**
   * ADR 0174: the practice chat (Settings → Oasis AI → Practice: the owner texts as a client, nothing is sent or booked). Off until
   * rollout; it works whatever AI_ENABLED says, with its own daily budget in US dollars (not counted in AI_DAILY_BUDGET_USD).
   */
  AI_PRACTICE_ENABLED: flag.default('false'),
  AI_PRACTICE_DAILY_BUDGET_USD: z.coerce.number().min(0).max(1000).default(3),
  AI_PRICE_INPUT_PER_MTOK: price(),
  AI_PRICE_OUTPUT_PER_MTOK: price(),
  AI_PRICE_CACHE_READ_PER_MTOK: price(),
  AI_PRICE_CACHE_WRITE_PER_MTOK: price(),
}
export const aiEnvFragment = z.object(aiEnvShape)
export type AiEnvFragment = z.infer<typeof aiEnvFragment>
