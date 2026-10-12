// The turn's append-only transcript (ADR 0160: assistant_turns.transcript, "redacted": no phone numbers, ids, tokens or codes).
// The model's own blocks are kept as they came (reasoning included: it is passed back unchanged within the turn), but what is
// stored goes through redactJson, which masks phone numbers, e-mail addresses, uuids and long digit runs anywhere in the value.
import type { AiMessage } from '../../integrations/ports/ai.js'
import type { JsonValue } from '../../platform/schema.js'
import { maskEmail, maskPhone } from '../../platform/phone.js'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const E164 = /\+\d{8,15}\b/g
/**
 * Phone numbers as people write them: ONE pattern set (PHONE_PATTERNS, in this order) shared by maskForModel (context.ts: what the
 * model reads) and redactText (what is stored), so both always mask the same things:
 *   INTL_PHONE   any "+" number with spaces, dots, dashes or brackets ("+44 20 7946 0958", "+1 (201) 555-0123")
 *   NANP_PHONE   "(201) 555-0123", "201.555.0123", "201-555-0123", "201 555 0123", "201/555-0123", "2015550123", "1-201-555-0123",
 *                "201–555–0123" (en dashes and the other Unicode dashes), "201_555_0123"
 *   SPLIT_PHONE  10 to 15 digits split any other way ("2 0 1 5 5 5 0 1 2 3", "201 555 01 23", "201-5550-123")
 *   LOCAL_PHONE  the 7-digit local form "555-0123" / "555.0123" / "555 0123"
 *   LONG_DIGITS  any other run of 7 or more digits (a code, an account number)
 * Not numbers: dates ("2026-06-13", "2026-06-13 10:30"), times ("10:30"), prices ("$1,299"), a ZIP+4 ("07026-1234"), an invoice
 * number ("INV-2026-0042"). The output guard does not use these: its digit rules (guard.ts digitWords) refuse codes and phone
 * numbers in the model's text on their own.
 */
export const INTL_PHONE = /\+\d(?:[\s()._\u2010-\u2015-]{0,2}\d){7,14}(?!\d)/g
export const NANP_PHONE = /(?<![\w+])(?:1[\s._\u2010-\u2015-]?)?(?:\(\d{3}\)|\d{3})[\s./_\u2010-\u2015-]?\d{3}[\s._\u2010-\u2015-]?\d{4}(?!\d)/g
export const SPLIT_PHONE = /(?<![\w+$:.,/-])(?:\d[\s()./_\u2010-\u2015-]{0,3}){9,14}\d(?![\d:])/g
export const LOCAL_PHONE = /(?<![\w$+.,:/*-])\d{3}[-. _\u2010-\u2015]\d{4}(?![\w-]|[.,:]\d)/g
export const LONG_DIGITS = /\b\d{7,}\b/g
export const PHONE_PATTERNS: readonly RegExp[] = [INTL_PHONE, NANP_PHONE, SPLIT_PHONE, LOCAL_PHONE, LONG_DIGITS]
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** Every phone number of the text replaced (PHONE_PATTERNS, in order). */
export function maskPhones(s: string, by: (match: string) => string): string {
  let out = s
  for (const re of PHONE_PATTERNS) out = out.replace(re, by)
  return out
}

export function redactText(s: string): string {
  return maskPhones(s.replace(UUID, '[id]').replace(EMAIL, (m) => maskEmail(m)).replace(E164, (m) => maskPhone(m)), (m) => maskPhone(m))
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
  | { kind: 'judge'; verdict: 'pass' | 'fail' | 'error'; category?: string; reason?: string; error?: string; model: string | null; latencyMs: number; attempts?: number }
  /** W4a fix F3: a throttled or timed-out model or judge call retried once (waitMs), or not retried for lack of time (skipped). */
  | { kind: 'retry'; call: 'model' | 'judge'; error: string; waitMs?: number; skipped?: 'deadline' }
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
