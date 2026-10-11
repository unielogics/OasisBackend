// The Assistant section of Settings (ADR 0160, design section 8, plan G): the AI text assistant's switch, the in-chat actions switch,
// the stage (who it answers), the allowlist of the first stage, how long a staff reply pauses it on a thread, and the FAQ it answers
// from. Every value is an ordinary registry setting (assistant.*, platform/settings.ts); the section reads and writes them together
// under one version token, the sum of the six setting versions, exactly like the Reminders section: a save names the version it was
// edited from (412 VERSION_CONFLICT otherwise) under a per-location advisory lock, and writes only the keys whose value changed (each
// audited and published as settings.changed, section "assistant", by updateSetting).
//
// Turning the switches on here is not enough for the AI to answer: AI_ENABLED (and AI_ACTIONS_ENABLED for in-chat actions) must be
// on in the server's environment too; the view says so (`server`, `active`).
import { sql } from 'kysely'
import { normalizeE164 } from '../../../integrations/sms/phone.js'
import type { AuditContext } from '../../../platform/audit.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { normalizeTextableNanp } from '../../../platform/phone.js'
import { getSetting, parseSetting, updateSetting, type SettingKey, type SettingValue } from '../../../platform/settings.js'

/** The section's fields and the setting each one is stored in. */
export const ASSISTANT_FIELDS = {
  enabled: 'assistant.enabled',
  actionsEnabled: 'assistant.actions_enabled',
  stage: 'assistant.stage',
  allowlist: 'assistant.allowlist',
  staffPauseHours: 'assistant.staff_pause_hours',
  faq: 'assistant.faq',
} as const satisfies Record<string, SettingKey>

export type AssistantField = keyof typeof ASSISTANT_FIELDS

export interface AssistantValues {
  enabled: boolean
  actionsEnabled: boolean
  stage: SettingValue<'assistant.stage'>
  allowlist: string[]
  staffPauseHours: number
  faq: { q: string; a: string }[]
}
export type AssistantPatch = Partial<AssistantValues>

export const ASSISTANT_KEYS: SettingKey[] = Object.values(ASSISTANT_FIELDS)

export interface AssistantSettings {
  values: AssistantValues
  /** Sum of the section's setting versions (0 when none was ever stored); every write to any of them raises it. */
  version: number
}

export async function loadAssistantSettings(db: Executor, locationId: string): Promise<AssistantSettings> {
  const values = {} as Record<string, unknown>
  let version = 0
  for (const [field, key] of Object.entries(ASSISTANT_FIELDS)) {
    const rec = await getSetting(db, locationId, key)
    values[field] = rec.value
    version += rec.version
  }
  return { values: values as unknown as AssistantValues, version }
}

interface Issue {
  path: string
  message: string
}

/**
 * Characters a plain-text FAQ line may not hold (review F1: the FAQ goes into the assistant's system prompt, so nothing a reader
 * cannot see may ride along): control characters (a tab or line break is fine), format characters (zero-width and direction marks,
 * the soft hyphen, the Unicode tag block U+E0000-E007F), line and paragraph separators, private-use, unassigned and lone surrogate
 * code points, and every default-ignorable code point (variation selectors, Hangul fillers, the combining grapheme joiner, ...).
 * The `u` flag makes it match whole code points, those above U+FFFF included.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
/** Plain-text whitespace a line may hold. */
const PLAIN_WHITESPACE = /[\t\n\r]/g
/**
 * The only invisible marks a phone keyboard puts in ordinary text: the emoji presentation selector (U+FE0F) right after an emoji or a
 * keycap base ("❤️", "1️⃣") and the zero-width joiner between two emoji ("👨‍👩‍👧"). One mark per position, so they cannot carry text.
 */
const EMOJI_GLUE = /(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}#*0-9])\uFE0F|(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D(?=\p{Extended_Pictographic})/gu

/** True when the line holds a character a reader cannot see (see HIDDEN). */
export const hasHiddenCharacters = (text: string): boolean => HIDDEN.test(text.replace(PLAIN_WHITESPACE, '').replace(EMOJI_GLUE, ''))
/** Markup: an HTML tag or comment. */
const MARKUP = /<\s*[a-z!/?][^>]*>/i

const sameQuestion = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Merges a patch over the stored values and validates the result: each value by its registry schema, then the section's own rules
 * (allowlist numbers normalised to E.164, textable US/Canadian numbers only, each listed once; FAQ lines plain text, each question once). Throws
 * VALIDATION_FAILED naming every problem; returns the merged values.
 */
export function mergeAssistantValues(current: AssistantValues, patch: AssistantPatch): AssistantValues {
  const issues: Issue[] = []
  const next = structuredClone(current) as unknown as Record<string, unknown>
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const key = ASSISTANT_FIELDS[field as AssistantField]
    if (!key) {
      issues.push({ path: field, message: 'Unknown field' })
      continue
    }
    let v: unknown = value
    // "(201) 555-0142" and "201-555-0142" are read as the E.164 number they name; anything else is checked as typed
    if (key === 'assistant.allowlist' && Array.isArray(v))
      v = v.map((n) => (typeof n === 'string' ? (normalizeE164(n) ?? n.trim()) : n))
    try {
      next[field] = parseSetting(key, v)
    } catch (e) {
      if (!(e instanceof AppError)) throw e
      const errs = (e.errors ?? []) as Issue[]
      for (const x of errs.length ? errs : [{ path: 'value', message: e.detail }])
        issues.push({ path: `${field}${x.path.replace(/^value/, '')}`, message: x.message })
    }
  }
  const out = next as unknown as AssistantValues
  if (!issues.some((i) => i.path.startsWith('allowlist'))) {
    const seen = new Set<string>()
    out.allowlist.forEach((n, i) => {
      // the gate answers textable US/Canadian numbers only (normalizeTextableNanp), so any other entry could never match (review F3)
      const textable = normalizeTextableNanp(n)
      if (!textable.ok || textable.e164 !== n)
        issues.push({ path: `allowlist.${i}`, message: 'The assistant texts US and Canadian mobile numbers only.' })
      else if (seen.has(n)) issues.push({ path: `allowlist.${i}`, message: 'Each number can be listed once.' })
      seen.add(n)
    })
  }
  if (!issues.some((i) => i.path.startsWith('faq'))) {
    const questions = new Set<string>()
    out.faq.forEach((pair, i) => {
      for (const part of ['q', 'a'] as const) {
        const text = pair[part]
        if (hasHiddenCharacters(text))
          issues.push({ path: `faq.${i}.${part}`, message: 'Use plain text: this line holds hidden or control characters.' })
        else if (MARKUP.test(text)) issues.push({ path: `faq.${i}.${part}`, message: 'Use plain text: no HTML tags.' })
      }
      const q = sameQuestion(pair.q)
      if (questions.has(q)) issues.push({ path: `faq.${i}.q`, message: 'This question is already in the list.' })
      questions.add(q)
    })
  }
  if (issues.length) throw new AppError('VALIDATION_FAILED', { detail: issues[0]!.message, errors: issues })
  return out
}

export interface SaveAssistantInput {
  locationId: string
  patch: AssistantPatch
  expectedVersion: number
  updatedBy: string | null
  audit: AuditContext
}

/** Saves the section: version check under the section lock, then one updateSetting per changed key. */
export async function saveAssistantSettings(
  tx: Tx,
  input: SaveAssistantInput,
): Promise<AssistantSettings & { changed: SettingKey[] }> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`settings.assistant:${input.locationId}`}, 0))`.execute(tx)
  const current = await loadAssistantSettings(tx, input.locationId)
  if (current.version !== input.expectedVersion)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: current.version } })
  const merged = mergeAssistantValues(current.values, input.patch)
  const changed: SettingKey[] = []
  for (const [field, key] of Object.entries(ASSISTANT_FIELDS) as [AssistantField, SettingKey][]) {
    if (JSON.stringify(current.values[field]) === JSON.stringify(merged[field])) continue
    await updateSetting(tx, {
      locationId: input.locationId,
      key,
      value: merged[field],
      updatedBy: input.updatedBy,
      audit: input.audit,
    })
    changed.push(key)
  }
  const saved = changed.length ? await loadAssistantSettings(tx, input.locationId) : current
  return { ...saved, changed }
}
