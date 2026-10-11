// Loop breakers of the assistant gate (ADR 0160, design section 3): pure checks that keep the AI out of conversations with machines
// and floods. An auto-responder answering every AI text with the same line, a phone stuck re-sending, a carrier notice from a short
// code, our own tablet: none of them gets an AI answer (the text is still filed exactly as without the assistant). The turn-level
// breaker (6 turns without progress) belongs to the turn (wave 3).
import type { AssistantGateReason } from '../../assistant/ports.js'

/** The third identical text from one number within LOOP_IDENTICAL_WINDOW_MS gets no AI answer (nor does any later one). */
export const LOOP_IDENTICAL_COUNT = 3
export const LOOP_IDENTICAL_WINDOW_MS = 30 * 60_000
/** More than LOOP_BURST_MAX texts from one number inside LOOP_BURST_WINDOW_MS: no AI answer. */
export const LOOP_BURST_MAX = 5
export const LOOP_BURST_WINDOW_MS = 60_000

export interface RecentInbound {
  body: string
  at: Date
}

/** The comparison form of a text: case, spacing, invisible characters and edge punctuation do not make two texts different. */
export function sameTextKey(body: string): string {
  return body
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * A sender the AI never talks to: no dialable number (an alphanumeric sender id such as "AMAZON", a 3-6 digit short code, junk)
 * or one of the shop's own numbers. `phone` is normalizeE164(from).
 */
export function senderBreaker(from: string, phone: string | null, ownNumbers: readonly string[]): AssistantGateReason | null {
  const raw = from.trim()
  if (phone === null || /\p{L}/u.test(raw)) return 'loop_sender'
  // a short code reported with a plus ("+72975") is still a short code
  if (raw.replace(/\D/g, '').length <= 6) return 'loop_sender'
  if (ownNumbers.includes(phone)) return 'own_number'
  return null
}

/**
 * `recent`: the number's texts received within the windows, the current one included (the inbound service has filed it).
 * True when the current text is the LOOP_IDENTICAL_COUNT-th (or later) identical one inside the window.
 */
export function identicalBreaker(body: string, recent: readonly RecentInbound[], now: Date): boolean {
  const key = sameTextKey(body)
  if (key.length === 0) return false
  const since = now.getTime() - LOOP_IDENTICAL_WINDOW_MS
  const same = recent.filter((r) => r.at.getTime() > since && r.at.getTime() <= now.getTime() && sameTextKey(r.body) === key).length
  return same >= LOOP_IDENTICAL_COUNT
}

/** True when the number sent more than LOOP_BURST_MAX texts within the last LOOP_BURST_WINDOW_MS (the current one included). */
export function burstBreaker(recent: readonly RecentInbound[], now: Date): boolean {
  const since = now.getTime() - LOOP_BURST_WINDOW_MS
  return recent.filter((r) => r.at.getTime() > since && r.at.getTime() <= now.getTime()).length > LOOP_BURST_MAX
}

export interface LoopInput {
  from: string
  phone: string | null
  ownNumbers: readonly string[]
  body: string
  now: Date
  recent: readonly RecentInbound[]
}

/** The first loop breaker that trips, or null. */
export function loopBreaker(i: LoopInput): AssistantGateReason | null {
  const sender = senderBreaker(i.from, i.phone, i.ownNumbers)
  if (sender) return sender
  if (burstBreaker(i.recent, i.now)) return 'loop_burst'
  if (identicalBreaker(i.body, i.recent, i.now)) return 'loop_identical'
  return null
}

/** How far back the gate reads the number's texts for the breakers. */
export const LOOP_LOOKBACK_MS = Math.max(LOOP_IDENTICAL_WINDOW_MS, LOOP_BURST_WINDOW_MS)
