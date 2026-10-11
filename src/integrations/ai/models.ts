// The Claude models the assistant may run on through Amazon Bedrock (ADR 0160, design sections 0 and 9). One list serves three
// readers: the IAM grant (pnpm aws:provision --bedrock allows exactly these inference profiles and their foundation models), the
// price defaults (cost_micros when no AI_PRICE_* is set) and the status page (a configured model outside this list is flagged).
//
// Owner, 2026-10-11: the account's Claude 5.x quotas are 0 until AWS support raises them, so the assistant runs on Claude Sonnet
// 4.6 for now (judge Opus 4.6); switching to Sonnet 5.5 later is AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5-5 and nothing
// else (the grant already covers it). Nothing in the request mapping depends on the model: effort stays off unless
// AI_BEDROCK_EFFORT_MODE says how, and no 5.x-only field is ever sent.
import type { AiPrices } from './cost.js'

export interface ClaudeBedrockModel {
  /** The cross-region (us.) inference profile id: what AI_BEDROCK_MODEL_ID holds and the app invokes. */
  profileId: string
  /** The foundation model the profile routes to (its IAM resource name; may end in * to cover the :N versions). */
  foundationModel: string
  label: string
  /** What the model is for in this deployment. */
  use: 'assistant' | 'judge'
  /**
   * Anthropic's list prices in USD per million tokens (input, output, cache read, 5-minute cache write = 1.25 x input), the
   * defaults when no AI_PRICE_* is set. Bedrock bills the account's own rates (a geographic us. profile can cost more than
   * these): set AI_PRICE_* from the Bedrock pricing page before relying on AI_DAILY_BUDGET_USD.
   */
  prices: AiPrices
}

/** The interim assistant model (owner 2026-10-11): Claude Sonnet 4.6 until the Claude 5.x quota is raised. */
export const INTERIM_ASSISTANT_MODEL = 'us.anthropic.claude-sonnet-4-6'
/** The model the assistant moves to once its quota is raised (one setting: AI_BEDROCK_MODEL_ID). */
export const TARGET_ASSISTANT_MODEL = 'us.anthropic.claude-sonnet-5-5'

export const CLAUDE_BEDROCK_MODELS: readonly ClaudeBedrockModel[] = [
  {
    profileId: 'us.anthropic.claude-sonnet-5-5',
    foundationModel: 'anthropic.claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    use: 'assistant',
    prices: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  },
  {
    profileId: 'us.anthropic.claude-opus-5-5',
    foundationModel: 'anthropic.claude-opus-5-5',
    label: 'Claude Opus 5.5',
    use: 'judge',
    prices: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  },
  {
    profileId: 'us.anthropic.claude-sonnet-4-6',
    foundationModel: 'anthropic.claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    use: 'assistant',
    prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  },
  {
    profileId: 'us.anthropic.claude-opus-4-6-v1',
    foundationModel: 'anthropic.claude-opus-4-6-v1*',
    label: 'Claude Opus 4.6',
    use: 'judge',
    prices: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  },
]

/** The listed model for an AI_BEDROCK_MODEL_ID (the profile id; a :N version suffix is ignored), or undefined. */
export function findClaudeModel(modelId: string): ClaudeBedrockModel | undefined {
  const id = modelId.trim().replace(/:\d+$/, '')
  return CLAUDE_BEDROCK_MODELS.find((m) => m.profileId === id)
}

/** The highest listed price of each kind: the conservative default for a model this list does not know. */
export function highestListPrices(): AiPrices {
  const max = (k: keyof AiPrices) => Math.max(...CLAUDE_BEDROCK_MODELS.map((m) => m.prices[k]))
  return {
    inputPerMTok: max('inputPerMTok'),
    outputPerMTok: max('outputPerMTok'),
    cacheReadPerMTok: max('cacheReadPerMTok'),
    cacheWritePerMTok: max('cacheWritePerMTok'),
  }
}
