// The turn's append-only transcript (ADR 0160: assistant_turns.transcript, "redacted": no phone numbers, ids, tokens or codes).
// The model's own blocks are kept as they came (reasoning included: it is passed back unchanged within the turn), but what is
// stored goes through redactJson, which masks phone numbers, e-mail addresses, uuids and long digit runs anywhere in the value.
import type { AiMessage } from '../../integrations/ports/ai.js'
import type { JsonValue } from '../../platform/schema.js'
import { maskEmail, maskPhone } from '../../platform/phone.js'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const E164 = /\+\d{8,15}\b/g
const DIGITS = /\b\d{7,}\b/g
/**
 * Phone numbers as people write them (shared with the turn context, context.ts maskForModel): "(201) 555-0123", "201.555.0123",
 * "201 555 0123", "+1 (201) 555-0123" (NANP), and any "+" number with spaces, dots or dashes ("+44 20 7946 0958").
 */
export const INTL_PHONE = /\+\d(?:[\s().-]{0,2}\d){7,14}(?!\d)/g
export const NANP_PHONE = /(?<![\w+])(?:1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export function redactText(s: string): string {
  return s
    .replace(UUID, '[id]')
    .replace(EMAIL, (m) => maskEmail(m))
    .replace(E164, (m) => maskPhone(m))
    .replace(INTL_PHONE, (m) => maskPhone(m))
    .replace(NANP_PHONE, (m) => maskPhone(m))
    .replace(DIGITS, (m) => maskPhone(m))
}

/** A deep copy with every string redacted (keys kept). */
export function redactJson(v: unknown): JsonValue {
  if (typeof v === 'string') return redactText(v)
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map(redactJson)
  if (typeof v === 'object') {
    const out: { [k: string]: JsonValue } = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = redactJson(x)
    return out
  }
  return null
}

export type TranscriptEntry =
  | { kind: 'system'; promptVersion: string; factsVersion: string; tools: string[] }
  | { kind: 'context'; text: string }
  | { kind: 'message'; message: AiMessage; stopReason?: string; usage?: Record<string, number> }
  | { kind: 'tools'; round: number; calls: { tool: string; outcome: string; error?: string }[] }
  | { kind: 'guard'; verdict: string; problems?: string[]; words?: string[] }
  | { kind: 'error'; error: string }
  | { kind: 'reply'; text: string; klass: string }
  | { kind: 'handoff'; reason: string }

/** Append-only within the turn; stored once, redacted, when the turn ends. */
export class Transcript {
  private readonly entries: TranscriptEntry[] = []
  add(e: TranscriptEntry): void {
    this.entries.push(structuredClone(e))
  }
  get length(): number {
    return this.entries.length
  }
  toJson(): JsonValue[] {
    return this.entries.map((e) => redactJson(e))
  }
}
