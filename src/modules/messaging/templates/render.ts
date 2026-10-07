import { prepareOutboundBody, type PreparedOutbound } from '../policy/body.js'
import type { SmsClass } from '../policy/classes.js'
import { isTemplateKey, TEMPLATES, type SmsTemplate, type TemplateKey } from './registry.js'

export class TemplateError extends Error {
  readonly code: 'unknown_template' | 'missing_variables' | 'unknown_variables' | 'empty_body'
  readonly details: string[]

  constructor(code: TemplateError['code'], message: string, details: string[] = []) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
    this.details = details
  }
}

export interface RenderOptions {
  /** Edited bodies from Settings, by template key. */
  bodies?: Partial<Record<string, string>>
  /** Whether {link} sentences survive in linkOptional templates. Mirrors RESCHEDULE_LINK_ENABLED. Default false. */
  linksEnabled?: boolean
}

export type TemplateVars = Record<string, string | number | null | undefined>

const BLOCK = /\{#([a-z_]+)\}([\s\S]*?)\{\/\1\}/g
const VAR = /\{([a-z_]+)\}/g

function present(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const s = String(value)
  return s.trim().length > 0 ? s : null
}

/** Names used as {name} or {#name}, in order of appearance. */
export function placeholdersOf(body: string): string[] {
  const names = new Set<string>()
  for (const m of body.matchAll(/\{#?([a-z_]+)\}/g)) if (m[1]) names.add(m[1])
  return [...names]
}

/** Removes every sentence that contains {link}. Sentences end at . ! or ? followed by whitespace. */
export function stripLinkSentences(body: string): string {
  const sentences = body.split(/(?<=[.!?])\s+/)
  return sentences
    .filter((s) => !s.includes('{link}'))
    .join(' ')
    .trim()
}

export function templateBody(key: TemplateKey, opts: RenderOptions = {}): string {
  return opts.bodies?.[key] ?? TEMPLATES[key].body
}

export interface RenderedTemplate {
  key: TemplateKey
  klass: SmsClass
  /** Text with the designs' typography, before GSM-7 normalisation. */
  text: string
}

export function renderTemplate(key: string, vars: TemplateVars = {}, opts: RenderOptions = {}): RenderedTemplate {
  if (!isTemplateKey(key)) throw new TemplateError('unknown_template', `No template "${key}"`)
  const tpl: SmsTemplate = TEMPLATES[key]
  let body = templateBody(key, opts)
  if (body.trim().length === 0) throw new TemplateError('empty_body', `Template "${key}" has an empty body`)

  const needLink = tpl.linkOptional === true
  const required = new Set<string>(tpl.required)
  if (needLink && !opts.linksEnabled) {
    body = stripLinkSentences(body)
    required.delete('link')
  }

  // Optional blocks first: shown only when their variable is present.
  body = body.replace(BLOCK, (_m, name: string, inner: string) => (present(vars[name]) === null ? '' : inner))

  const missing = [...required].filter((name) => present(vars[name]) === null)
  const used = new Set<string>()
  for (const m of body.matchAll(VAR)) if (m[1]) used.add(m[1])
  for (const name of used) if (present(vars[name]) === null && !missing.includes(name)) missing.push(name)
  if (missing.length > 0) throw new TemplateError('missing_variables', `Template "${key}" needs: ${missing.join(', ')}`, missing)

  const text = body.replace(VAR, (_m, name: string) => present(vars[name]) ?? '').replace(/[ \t]{2,}/g, ' ').trim()
  return { key, klass: tpl.klass, text }
}

export interface RenderedSms extends RenderedTemplate {
  prepared: PreparedOutbound
}

/** Render, normalise to GSM-7, add the STOP footer where required and count segments. */
export function renderSms(
  key: string,
  vars: TemplateVars,
  opts: RenderOptions & { firstMessageToNumber: boolean },
): RenderedSms {
  const rendered = renderTemplate(key, vars, opts)
  return { ...rendered, prepared: prepareOutboundBody(rendered.text, rendered.klass, { firstMessageToNumber: opts.firstMessageToNumber }) }
}

export interface BodyProblem {
  code: 'empty' | 'unknown_variable'
  detail: string
}

/** Validates an edited body from Settings: it may only use the template's own variables. */
export function validateTemplateBody(key: string, body: string): BodyProblem[] {
  if (!isTemplateKey(key)) return [{ code: 'unknown_variable', detail: `No template "${key}"` }]
  const problems: BodyProblem[] = []
  if (body.trim().length === 0) problems.push({ code: 'empty', detail: 'Body is empty' })
  const tpl: SmsTemplate = TEMPLATES[key]
  const allowed = new Set<string>([...tpl.required, ...tpl.optional])
  for (const name of placeholdersOf(body)) {
    if (!allowed.has(name)) problems.push({ code: 'unknown_variable', detail: `{${name}} is not available in "${key}"` })
  }
  return problems
}
