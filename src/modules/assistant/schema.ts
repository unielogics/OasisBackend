// Kysely types for the assistant tables (migration 20261011000100_assistant.sql, ADR 0160): conversations, turns and tool calls,
// plus the columns that migration adds to sms_inbox and message_threads. Registered by module augmentation.
import type { Generated } from 'kysely'
import type { JsonColumn, JsonValue } from '../../platform/schema.js'

export type HandoffState = 'open' | 'resolved'
export type AssistantTurnStatus = 'running' | 'replied' | 'handed_off' | 'skipped' | 'failed'
/** What the caller was known as when the turn started. */
export type AssistantTrust = 'unknown' | 'known' | 'trusted'
export type AssistantProviderName = 'sim' | 'bedrock'
export type ToolCallOutcome = 'ok' | 'error' | 'denied'
/** sms_inbox.decision values this feature adds (the column is free text in the types; the check lists every value). */
export type AssistantInboxDecision = 'assistant' | 'handoff' | 'action_code'

export interface AssistantConversationsTable {
  id: string
  location_id: string
  phone_e164: string
  customer_id: string | null
  pending_since: Date | null
  last_inbound_at: Date | null
  running_since: Date | null
  handoff_state: HandoffState | null
  handoff_reason: string | null
  handoff_at: Date | null
  last_fallback_at: Date | null
  disclosed_at: Date | null
  /** The client's language ('en' | 'es', ADR 0160 W4b X5): the server's own words (disclosure, footer, renderings) follow it. */
  language: Generated<string>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface AssistantTurnsTable {
  id: string
  conversation_id: string
  status: Generated<AssistantTurnStatus>
  trust: AssistantTrust
  provider: AssistantProviderName
  model: string | null
  prompt_version: string | null
  rounds: Generated<number>
  tokens_in: Generated<number>
  tokens_out: Generated<number>
  tokens_cache_read: Generated<number>
  tokens_cache_write: Generated<number>
  /** USD millionths (int8, parsed to number by the pool). */
  cost_micros: Generated<number>
  stop_reason: string | null
  latency_ms: number | null
  reply_message_id: string | null
  transcript: Generated<JsonColumn<JsonValue[]>>
  error: string | null
  started_at: Generated<Date>
  finished_at: Date | null
}

export interface AssistantToolCallsTable {
  id: string
  turn_id: string
  seq: number
  round: number
  tool: string
  tool_use_id: string | null
  input: JsonColumn<{ [key: string]: JsonValue }>
  output: JsonColumn | null
  outcome: ToolCallOutcome
  error: string | null
  latency_ms: number | null
  created_at: Generated<Date>
}

declare module '../messaging/schema.js' {
  interface SmsInboxTable {
    assistant_conversation_id: string | null
    assistant_turn_id: string | null
  }
  interface MessageThreadsTable {
    /** A staff reply pauses the AI on the thread until then. */
    ai_paused_until: Date | null
    ai_paused_by: string | null
  }
}

declare module '../../platform/schema.js' {
  interface Database {
    assistant_conversations: AssistantConversationsTable
    assistant_turns: AssistantTurnsTable
    assistant_tool_calls: AssistantToolCallsTable
  }
}
