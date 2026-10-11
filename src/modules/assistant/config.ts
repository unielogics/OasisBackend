// The assistant turn's numbers (ADR 0160, design sections 1 "Env" and 3), read once from the environment. Everything that limits a
// turn or the day lives here so the tests can shorten the clocks.
import type { Env } from '../../config/env.js'
import { aiPricesFromEnv, type AiPrices } from '../../integrations/ai/cost.js'
import { findClaudeModel, highestListPrices } from '../../integrations/ai/models.js'
import { JUDGE_MAX_TOKENS, JUDGE_TIMEOUT_MS } from './judge.js'

export interface AssistantCaps {
  perNumberHour: number
  perNumberDay: number
  /** A number with no client behind it (or a stale record). */
  unknownDay: number
  globalHour: number
  globalDay: number
  /** AI_DAILY_BUDGET_USD in micro-dollars: today's (business day) spend at which the AI stops answering. */
  dailyBudgetMicros: number
}

/** The output guard's policy judge (design section 3c, judge.ts). */
export interface JudgeConfig {
  /** AI_GUARD_JUDGE, unset = AI_ENABLED. */
  enabled: boolean
  /** AI_GUARD_MODEL_ID, unset = AI_BEDROCK_MODEL_ID. */
  modelId: string
  /** One judge call (8 s); a timeout fails closed. */
  timeoutMs: number
  maxTokens: number
  /** The judge model's prices: the assistant's (AI_PRICE_* included) when it is the same model, else its list prices. */
  prices: AiPrices
}

export interface AssistantConfig {
  aiEnabled: boolean
  /** AI_ACTIONS_ENABLED (the setting assistant.actions_enabled must be on too). */
  actionsEnabled: boolean
  maxTokens: number
  effort: 'low' | 'medium' | 'high'
  /** One model call (AI_TIMEOUT_MS). */
  callTimeoutMs: number
  /** The whole turn (AI_TURN_DEADLINE_MS). */
  turnDeadlineMs: number
  /** Quiet time after the newest text before answering (AI_DEBOUNCE_MS). */
  debounceMs: number
  /** A burst is answered at the latest this long after its first text, quiet or not. */
  maxDeferMs: number
  /** The sweep re-kicks markers older than this. */
  sweepMarkerMs: number
  /** A running turn older than this is failed by the sweep (fallback + handoff). */
  leaseMs: number
  /** Texts older than this cannot be answered any more (the reply classes' 15-minute window): staff take them. */
  staleMarkerMs: number
  /** At most this many tool rounds, then one "reply now" call. */
  maxToolRounds: number
  /** The fixed fallback text goes at most once per this long per conversation. */
  fallbackEveryMs: number
  /** This many answered turns in a row without progress hand the conversation to staff (design section 3 loop breakers). */
  noProgressTurns: number
  historyLimit: number
  historyWindowMs: number
  caps: AssistantCaps
  prices: AiPrices
  judge: JudgeConfig
}

/** The judge's settings from the environment. */
export function judgeConfig(env: Pick<Env, 'AI_ENABLED' | 'AI_GUARD_JUDGE' | 'AI_GUARD_MODEL_ID' | 'AI_BEDROCK_MODEL_ID'>, assistantPrices: AiPrices): JudgeConfig {
  const modelId = env.AI_GUARD_MODEL_ID ?? env.AI_BEDROCK_MODEL_ID
  const same = modelId === env.AI_BEDROCK_MODEL_ID
  return {
    enabled: env.AI_GUARD_JUDGE ?? env.AI_ENABLED,
    modelId,
    timeoutMs: JUDGE_TIMEOUT_MS,
    maxTokens: JUDGE_MAX_TOKENS,
    prices: same ? assistantPrices : (findClaudeModel(modelId)?.prices ?? highestListPrices()),
  }
}

export function assistantConfig(env: Env): AssistantConfig {
  const prices = aiPricesFromEnv(env)
  return {
    aiEnabled: env.AI_ENABLED,
    actionsEnabled: env.AI_ACTIONS_ENABLED,
    maxTokens: env.AI_MAX_TOKENS,
    effort: env.AI_EFFORT,
    callTimeoutMs: env.AI_TIMEOUT_MS,
    turnDeadlineMs: env.AI_TURN_DEADLINE_MS,
    debounceMs: env.AI_DEBOUNCE_MS,
    maxDeferMs: 45_000,
    sweepMarkerMs: 30_000,
    leaseMs: 3 * 60_000,
    staleMarkerMs: 15 * 60_000,
    maxToolRounds: 4,
    fallbackEveryMs: 2 * 3600_000,
    noProgressTurns: 6,
    historyLimit: 20,
    historyWindowMs: 48 * 3600_000,
    caps: {
      perNumberHour: env.AI_TURNS_PER_NUMBER_HOUR,
      perNumberDay: env.AI_TURNS_PER_NUMBER_DAY,
      unknownDay: env.AI_TURNS_UNKNOWN_DAY,
      globalHour: env.AI_GLOBAL_TURNS_HOUR,
      globalDay: env.AI_GLOBAL_TURNS_DAY,
      dailyBudgetMicros: Math.round(env.AI_DAILY_BUDGET_USD * 1_000_000),
    },
    prices,
    judge: judgeConfig(env, prices),
  }
}
