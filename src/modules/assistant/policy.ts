// The owner's limits and tone as the turn applies them (ADR 0174 §3, design k-design-assistant.md §3b). Settings only take abilities
// away, never add one: `assistant.capabilities` narrows the tools offered to the model (and the runner refuses what is not offered),
// `assistant.behavior` adds the owner block after the binding rules (tone, length, words and topics to avoid, topics always handed to
// the team, quoted style notes), a guard check for the words to avoid, a server backstop for the handoff topics, the Spanish mode
// and the server's sign-off. The defaults (registry: every capability on, tone friendly, length standard, Spanish on, no lists, no
// sign-off) are today's behaviour: the prompt, the tools and the reply are then exactly what they were before ADR 0174.
import { createHash } from 'node:crypto'
import type { Executor } from '../../platform/db.js'
import { defaultSetting, getSetting, type SettingValue } from '../../platform/settings.js'

export type Capabilities = SettingValue<'assistant.capabilities'>
export type Behavior = SettingValue<'assistant.behavior'>
export type Tone = Behavior['tone']

/** The personal link kinds send_link can text (contract ToolInputs['send_link']['kind']). */
export type LinkKind = 'calendar' | 'verify' | 'pin' | 'membership' | 'pay'
export const LINK_KINDS: readonly LinkKind[] = ['calendar', 'verify', 'pin', 'membership', 'pay']

/**
 * What the model may do this turn (design §3b): the in-chat actions (AI_ACTIONS_ENABLED and assistant.actions_enabled, as before),
 * checking open times, the account lookups (balance, visits, membership status) and the link kinds send_link may text:
 *   calendar: bookingLinks · verify: bookingLinks || actions · membership: membershipLinks · pay: paymentLinks ·
 *   pin: accountInfo || membershipLinks || paymentLinks
 */
export interface ToolPolicy {
  actions: boolean
  availability: boolean
  accountInfo: boolean
  linkKinds: ReadonlySet<LinkKind>
}

export interface AssistantPolicy {
  capabilities: Capabilities
  behavior: Behavior
  tools: ToolPolicy
}

export const DEFAULT_CAPABILITIES: Capabilities = defaultSetting('assistant.capabilities')
export const DEFAULT_BEHAVIOR: Behavior = defaultSetting('assistant.behavior')

export function toolPolicy(c: Capabilities, actions: boolean): ToolPolicy {
  const kinds = new Set<LinkKind>()
  if (c.bookingLinks) kinds.add('calendar')
  if (c.bookingLinks || actions) kinds.add('verify')
  if (c.accountInfo || c.membershipLinks || c.paymentLinks) kinds.add('pin')
  if (c.membershipLinks) kinds.add('membership')
  if (c.paymentLinks) kinds.add('pay')
  return { actions, availability: c.availability, accountInfo: c.accountInfo, linkKinds: kinds }
}

export function assistantPolicy(c: Capabilities, b: Behavior, actions: boolean): AssistantPolicy {
  return { capabilities: c, behavior: b, tools: toolPolicy(c, actions) }
}

/** The policy of the defaults (every capability on, today's behaviour). */
export const defaultPolicy = (actions: boolean): AssistantPolicy => assistantPolicy(DEFAULT_CAPABILITIES, DEFAULT_BEHAVIOR, actions)

/** The location's limits and tone, read at the turn's start. `actions`: the in-chat actions switch the turn already decided. */
export async function loadPolicy(db: Executor, locationId: string, actions: boolean): Promise<AssistantPolicy> {
  const c = (await getSetting(db, locationId, 'assistant.capabilities')).value
  const b = (await getSetting(db, locationId, 'assistant.behavior')).value
  return assistantPolicy(c, b, actions)
}

/** Every capability on (the five of `assistant.capabilities`): the tools are exactly today's. */
export const allCapabilities = (c: Capabilities): boolean => c.availability && c.bookingLinks && c.membershipLinks && c.paymentLinks && c.accountInfo

/** Every link kind send_link knows is offered. */
export const allLinkKinds = (p: ToolPolicy): boolean => LINK_KINDS.every((k) => p.linkKinds.has(k))

/** The owner settings that change the prompt are all at their defaults (the owner block is then left out). */
export function defaultPrompt(p: AssistantPolicy): boolean {
  const b = p.behavior
  return (
    allCapabilities(p.capabilities) &&
    b.tone === DEFAULT_BEHAVIOR.tone &&
    b.length === DEFAULT_BEHAVIOR.length &&
    b.styleNotes.trim() === '' &&
    b.avoidWords.length === 0 &&
    b.avoidTopics.length === 0 &&
    b.handoffTopics.length === 0 &&
    b.signOff.trim() === ''
  )
}

/** A short fingerprint of the owner's limits and tone, recorded with a turn whose prompt they changed (transcript `system`). */
export function policyHash(p: AssistantPolicy): string {
  const b = p.behavior
  const canonical = JSON.stringify([
    p.tools.actions,
    LINK_KINDS.filter((k) => p.tools.linkKinds.has(k)),
    p.capabilities.availability,
    p.capabilities.accountInfo,
    b.tone,
    b.length,
    b.styleNotes,
    b.spanish,
    b.avoidWords,
    b.avoidTopics,
    b.handoffTopics,
    b.signOff,
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// ---- phrases the owner listed (words to avoid, topics handed to the team) -----------------------------------------------------------

/** Lower case, accents and punctuation out, one space between words: "Insurance-Claims!" -> "insurance claims". */
export function foldPhrase(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’‘']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The pattern of a listed phrase over folded text: whole words, in order, each word also in its plural ("claim" matches "claims",
 * "insurance claims" matches "insurance claim"). Null for a phrase with no letter or digit.
 */
export function phrasePattern(phrase: string): RegExp | null {
  const words = foldPhrase(phrase).split(' ').filter(Boolean)
  if (words.length === 0) return null
  const parts = words.map((w) => {
    const stem = w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w
    return `${escape(stem)}(?:s|es)?`
  })
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join(' ')}(?![\\p{L}\\p{N}])`, 'u')
}

/** The listed phrases a text holds (case, accents and punctuation ignored; whole words), in the list's order. */
export function phrasesIn(text: string, phrases: readonly string[]): string[] {
  const folded = foldPhrase(text)
  if (folded === '') return []
  return phrases.filter((p) => phrasePattern(p)?.test(folded) === true)
}

/** The first handoff topic one of the client's texts names, or null. */
export function handoffTopicIn(texts: readonly string[], topics: readonly string[]): string | null {
  if (topics.length === 0) return null
  for (const t of texts) {
    const hit = phrasesIn(t, topics)[0]
    if (hit) return hit
  }
  return null
}
