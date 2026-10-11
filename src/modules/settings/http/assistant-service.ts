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

/** Characters a plain-text FAQ line may not hold: control characters (a tab or line break is fine), zero-width and direction marks. */
const HIDDEN_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
]
const u = (n: number): string => `\\u${n.toString(16).padStart(4, '0')}`
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => `${u(a)}-${u(b)}`).join('')}]`)
/** Markup: an HTML tag or comment. */
const MARKUP = /<\s*[a-z!/?][^>]*>/i

const sameQuestion = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Merges a patch over the stored values and validates the result: each value by its registry schema, then the section's own rules
 * (allowlist numbers normalised to E.164, US/Canadian only, each listed once; FAQ lines plain text, each question once). Throws
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
      if (!/^\+1\d{10}$/.test(n))
        issues.push({ path: `allowlist.${i}`, message: 'The assistant texts US and Canadian numbers only.' })
      else if (seen.has(n)) issues.push({ path: `allowlist.${i}`, message: 'Each number can be listed once.' })
      seen.add(n)
    })
  }
  if (!issues.some((i) => i.path.startsWith('faq'))) {
    const questions = new Set<string>()
    out.faq.forEach((pair, i) => {
      for (const part of ['q', 'a'] as const) {
        const text = pair[part]
        if (HIDDEN.test(text))
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
