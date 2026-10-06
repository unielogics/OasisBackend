import type { EmailRequest } from '../ports/email.js'
import { EmailError } from './errors.js'
import { renderHtml, renderText, type Doc } from './content.js'

export type TemplateKey = 'receipt' | 'staff_invite' | 'password_reset' | 'device_alert' | 'closure_notice'

type VarKind = 'text' | 'multiline' | 'url' | 'cents' | 'int' | 'items'
interface VarSpec {
  kind: VarKind
  required?: boolean
  default?: string
  max?: number
}

/** Validated variables handed to a template body: strings are control-char free, cents/int are numbers. */
type Vars = Record<string, string | number | undefined>

interface TemplateDef {
  key: TemplateKey
  vars: Record<string, VarSpec>
  build(v: Vars): Doc
}

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

export interface ReceiptItem {
  description: string
  cents: number
}

/** Receipt line items travel as one multiline variable: `description<TAB>cents` per line. */
export function encodeReceiptItems(items: readonly ReceiptItem[]): string {
  return items
    .map((i) => {
      if (!Number.isSafeInteger(i.cents)) throw new EmailError('INVALID_VAR', 'item cents must be an integer')
      return `${i.description.replace(/[\t\r\n]+/g, ' ').trim()}\t${i.cents}`
    })
    .join('\n')
}

export function formatCents(cents: number): string {
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`
}

const SHOP = 'Oasis Auto Spa'
const shopVars = {
  shopName: { kind: 'text', default: SHOP, max: 80 },
  shopPhone: { kind: 'text', max: 40 },
} satisfies Record<string, VarSpec>

const footer = (v: Vars) =>
  [String(v.shopName), v.shopPhone ? String(v.shopPhone) : ''].filter(Boolean).join('\n')
const hello = (name: unknown) => (name ? `Hi ${String(name)},` : 'Hello,')

const defs: TemplateDef[] = [
  {
    key: 'receipt',
    vars: {
      customerName: { kind: 'text', required: true, max: 120 },
      invoiceNumber: { kind: 'text', required: true, max: 40 },
      dateLabel: { kind: 'text', required: true, max: 60 },
      vehicle: { kind: 'text', max: 120 },
      items: { kind: 'items', required: true, max: 4000 },
      subtotalCents: { kind: 'cents', required: true },
      taxCents: { kind: 'cents', required: true },
      tipCents: { kind: 'cents' },
      totalCents: { kind: 'cents', required: true },
      paidCents: { kind: 'cents', required: true },
      balanceCents: { kind: 'cents', required: true },
      paymentSummary: { kind: 'text', max: 160 },
      ...shopVars,
    },
    build: (v) => {
      const lines: Array<readonly [string, string]> = String(v.items)
        .split('\n')
        .map((l) => {
          const [d, c] = l.split('\t') as [string, string]
          return [d, formatCents(Number(c))] as const
        })
      const rows: Array<readonly [string, string]> = [
        ...lines,
        ['Subtotal', formatCents(v.subtotalCents as number)],
        ['Tax', formatCents(v.taxCents as number)],
      ]
      if (v.tipCents !== undefined) rows.push(['Tip', formatCents(v.tipCents as number)])
      rows.push(['Total', formatCents(v.totalCents as number)])
      const facts: Array<readonly [string, string]> = [
        ['Invoice', String(v.invoiceNumber)],
        ['Date', String(v.dateLabel)],
      ]
      if (v.vehicle) facts.push(['Vehicle', String(v.vehicle)])
      const balance = v.balanceCents as number
      const blocks: Doc['blocks'] = [
        {
          t: 'p',
          text: `${hello(v.customerName)}\nThank you for visiting ${v.shopName}. Here is your receipt.`,
        },
        { t: 'facts', rows: facts },
        { t: 'items', rows, emphasizeLast: true },
        {
          t: 'facts',
          rows: [
            ['Paid', formatCents(v.paidCents as number)],
            ['Balance due', formatCents(balance)],
          ],
        },
      ]
      if (v.paymentSummary) blocks.push({ t: 'note', text: `Payment: ${v.paymentSummary}` })
      return {
        subject: `Your receipt from ${v.shopName} (${v.invoiceNumber})`,
        heading: `Receipt ${v.invoiceNumber}`,
        blocks,
        footer: footer(v),
      }
    },
  },
  {
    key: 'staff_invite',
    vars: {
      inviteeName: { kind: 'text', required: true, max: 120 },
      inviterName: { kind: 'text', max: 120 },
      roleName: { kind: 'text', max: 80 },
      inviteUrl: { kind: 'url', required: true },
      expiresLabel: { kind: 'text', max: 60 },
      ...shopVars,
    },
    build: (v) => ({
      subject: `You are invited to join ${v.shopName}`,
      heading: `Join ${v.shopName}`,
      blocks: [
        {
          t: 'p',
          text:
            `${hello(v.inviteeName)}\n` +
            `${v.inviterName ? `${v.inviterName} has` : 'You have been'} invited you to the ${v.shopName} dashboard` +
            `${v.roleName ? ` as ${v.roleName}` : ''}. Set your password to finish creating your account.`,
        },
        { t: 'button', label: 'Set your password', url: String(v.inviteUrl) },
        ...(v.expiresLabel
          ? [{ t: 'note' as const, text: `This invitation expires ${v.expiresLabel}.` }]
          : []),
        { t: 'note', text: 'If you were not expecting this invitation you can ignore this email.' },
      ],
      footer: footer(v),
    }),
  },
  {
    key: 'password_reset',
    vars: {
      recipientName: { kind: 'text', max: 120 },
      resetUrl: { kind: 'url', required: true },
      expiresMinutes: { kind: 'int', required: true },
      ...shopVars,
    },
    build: (v) => ({
      subject: `Reset your ${v.shopName} password`,
      heading: 'Reset your password',
      blocks: [
        {
          t: 'p',
          text: `${hello(v.recipientName)}\nSomeone asked to reset the password for your ${v.shopName} account. Use the link below to choose a new one.`,
        },
        { t: 'button', label: 'Choose a new password', url: String(v.resetUrl) },
        { t: 'note', text: `This link works once and expires in ${v.expiresMinutes} minutes.` },
        { t: 'note', text: 'If you did not ask for this, ignore this email; your password has not changed.' },
      ],
      footer: footer(v),
    }),
  },
  {
    key: 'device_alert',
    vars: {
      deviceLabel: { kind: 'text', required: true, max: 120 },
      status: { kind: 'text', required: true, max: 60 },
      occurredLabel: { kind: 'text', required: true, max: 80 },
      detail: { kind: 'multiline', max: 1000 },
      dashboardUrl: { kind: 'url' },
      ...shopVars,
    },
    build: (v) => ({
      subject: `[Alert] ${v.deviceLabel} is ${v.status}`,
      heading: `${v.deviceLabel} is ${v.status}`,
      blocks: [
        {
          t: 'facts',
          rows: [
            ['Device', String(v.deviceLabel)],
            ['Status', String(v.status)],
            ['Since', String(v.occurredLabel)],
          ],
        },
        ...(v.detail ? [{ t: 'p' as const, text: String(v.detail) }] : []),
        { t: 'p', text: 'Customer text messages stay queued until the device is back online.' },
        ...(v.dashboardUrl
          ? [{ t: 'button' as const, label: 'Open the dashboard', url: String(v.dashboardUrl) }]
          : []),
      ],
      footer: footer(v),
    }),
  },
  {
    key: 'closure_notice',
    vars: {
      customerName: { kind: 'text', required: true, max: 120 },
      closureLabel: { kind: 'text', required: true, max: 120 },
      reason: { kind: 'text', max: 200 },
      message: { kind: 'multiline', max: 1000 },
      rescheduleUrl: { kind: 'url' },
      ...shopVars,
    },
    build: (v) => ({
      subject: `${v.shopName} schedule change: ${v.closureLabel}`,
      heading: `We are closed ${v.closureLabel}`,
      blocks: [
        {
          t: 'p',
          text:
            `${hello(v.customerName)}\nWe will be closed ${v.closureLabel}${v.reason ? ` (${v.reason})` : ''}. ` +
            `We are sorry for the inconvenience.`,
        },
        ...(v.message ? [{ t: 'p' as const, text: String(v.message) }] : []),
        ...(v.rescheduleUrl
          ? [{ t: 'button' as const, label: 'Pick a new time', url: String(v.rescheduleUrl) }]
          : [{ t: 'p' as const, text: 'Reply to this email or call us and we will find you a new time.' }]),
      ],
      footer: footer(v),
    }),
  },
]

const registry: ReadonlyMap<string, TemplateDef> = new Map(defs.map((d) => [d.key, d]))

export const templateKeys: readonly TemplateKey[] = defs.map((d) => d.key)

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g

function checkVar(tpl: string, name: string, spec: VarSpec, raw: string | number): string | number {
  const bad = (why: string) => new EmailError('INVALID_VAR', `${tpl}.${name}: ${why}`)
  switch (spec.kind) {
    case 'cents':
    case 'int': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) throw bad('must be an integer number')
      if (spec.kind === 'int' && raw < 0) throw bad('must not be negative')
      return raw
    }
    case 'url': {
      const s = String(raw).trim()
      let u: URL
      try {
        u = new URL(s)
      } catch {
        throw bad('must be an absolute URL')
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('must be an http(s) URL')
      if (u.username || u.password) throw bad('must not embed credentials')
      if (/[\s<>"']/.test(s) || s.length > 2000) throw bad('contains unsafe characters')
      return u.toString()
    }
    case 'items': {
      const s = String(raw)
      for (const line of s.split('\n')) {
        if (!/^[^\t]+\t-?\d{1,12}$/.test(line)) throw bad('each line must be "description<TAB>integer cents"')
      }
      return s.replace(CONTROL, '')
    }
    case 'multiline':
    case 'text': {
      let s = String(raw).replace(/\r\n?/g, '\n')
      if (spec.kind === 'text') s = s.replace(/\n+/g, ' ')
      s = s.replace(CONTROL, '').trim()
      if (s.length > (spec.max ?? 500)) throw bad(`longer than ${spec.max ?? 500} characters`)
      return s
    }
  }
}

function checkVars(def: TemplateDef, input: EmailRequest['vars']): Vars {
  const out: Vars = {}
  for (const k of Object.keys(input)) {
    if (!(k in def.vars)) throw new EmailError('UNKNOWN_VAR', `${def.key}: unknown variable "${k}"`)
  }
  for (const [name, spec] of Object.entries(def.vars)) {
    const raw = input[name] ?? spec.default
    if (raw === undefined || raw === '') {
      if (spec.required) throw new EmailError('MISSING_VAR', `${def.key}: missing variable "${name}"`)
      continue
    }
    out[name] = checkVar(def.key, name, spec, raw)
  }
  return out
}

const oneLine = (s: string) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)

export function renderTemplate(req: Pick<EmailRequest, 'template' | 'vars' | 'subject'>): RenderedEmail {
  const def = registry.get(req.template)
  if (!def) throw new EmailError('UNKNOWN_TEMPLATE', `unknown email template "${req.template}"`)
  const doc = def.build(checkVars(def, req.vars))
  const subject = oneLine(req.subject ?? doc.subject)
  const final: Doc = { ...doc, subject }
  return { subject, text: renderText(final), html: renderHtml(final) }
}
