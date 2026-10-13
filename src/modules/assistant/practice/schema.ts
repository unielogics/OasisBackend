// Kysely types for the practice chat (migration 20261016200200_assistant_practice.sql, ADR 0174 §4c): the sessions and their turns,
// the only tables practice writes. Registered by module augmentation.
import type { ColumnType, Generated } from 'kysely'
import type { JsonValue } from '../../../platform/schema.js'

export type PracticePersona = 'new_texter' | 'client'
export type PracticeTurnStatus = 'running' | 'replied' | 'handed_off' | 'failed' | 'opted_out'

export interface AssistantPracticeSessionsTable {
  id: string
  location_id: string
  user_id: string
  persona: PracticePersona
  customer_id: string | null
  verified: Generated<boolean>
  include_entry_ids: Generated<string[]>
  language: Generated<'en' | 'es'>
  /** jsonb (practice/state.ts PracticeState), written as JSON text. */
  state: ColumnType<JsonValue, string | undefined, string>
  turns: Generated<number>
  cost_micros: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface AssistantPracticeTurnsTable {
  id: string
  session_id: string
  seq: number
  rerun_of: string | null
  client_text: string
  status: Generated<PracticeTurnStatus>
  reply_text: string | null
  extra_texts: ColumnType<JsonValue, string | undefined, string>
  badges: ColumnType<JsonValue, string | undefined, string>
  error: string | null
  model: string | null
  prompt_version: string | null
  facts_version: string | null
  tokens_in: Generated<number>
  tokens_out: Generated<number>
  tokens_cache_read: Generated<number>
  tokens_cache_write: Generated<number>
  cost_micros: Generated<number>
  latency_ms: number | null
  /** The session's state when the turn began (a re-run starts from it). */
  state_before: ColumnType<JsonValue, string | undefined, string>
  transcript: ColumnType<JsonValue | null, string | null | undefined, string | null>
  tool_calls: ColumnType<JsonValue, string | undefined, string>
  started_at: Generated<Date>
  finished_at: Date | null
}

declare module '../../../platform/schema.js' {
  interface Database {
    assistant_practice_sessions: AssistantPracticeSessionsTable
    assistant_practice_turns: AssistantPracticeTurnsTable
  }
}
