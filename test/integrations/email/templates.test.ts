import { describe, expect, it } from 'vitest'
import { EmailError } from '../../../src/integrations/email/errors.js'
import {
  encodeReceiptItems,
  formatCents,
  renderTemplate,
  templateKeys,
} from '../../../src/integrations/email/templates.js'

const valid: Record<string, Record<string, string | number>> = {
  receipt: {
    customerName: 'Aisha Rahman',
    invoiceNumber: 'INV-20611',
    dateLabel: 'Sat, Jun 13',
    vehicle: '2022 Tesla Model 3',
    items: encodeReceiptItems([
      { description: 'Full Detail', cents: 18000 },
      { description: 'Ceramic add-on', cents: 4999 },
    ]),
    subtotalCents: 22999,
    taxCents: 1610,
    tipCents: 2000,
    totalCents: 26609,
    paidCents: 26609,
    balanceCents: 0,
    paymentSummary: 'Visa, processed in Squarespace',
  },
  staff_invite: {
    inviteeName: 'Kevin',
    inviterName: 'Rafael M.',
    roleName: 'Crew',
    inviteUrl: 'https://app.example.com/invite?t=abc',
    expiresLabel: 'on Jun 20',
  },
  password_reset: {
    recipientName: 'Kevin',
    resetUrl: 'https://app.example.com/reset?t=abc',
    expiresMinutes: 30,
  },
  device_alert: {
    deviceLabel: 'Front desk tablet',
    status: 'offline',
    occurredLabel: '10:36 AM',
    detail: 'No heartbeat for 3 minutes',
    dashboardUrl: 'https://app.example.com/operations',
  },
  closure_notice: {
    customerName: 'Liam',
    closureLabel: 'Saturday, June 13',
    reason: 'storm',
    message: 'Stay safe.',
  },
}

describe('template registry', () => {
  it('has a valid fixture for every template key', () => {
    expect(Object.keys(valid).sort()).toEqual([...templateKeys].sort())
  })

  it.each(Object.keys(valid))('%s renders subject, text and html', (template) => {
    const r = renderTemplate({ template, vars: valid[template]! })
    expect(r.subject.length).toBeGreaterThan(5)
    expect(r.subject).not.toMatch(/[\r\n]/)
    expect(r.text.length).toBeGreaterThan(50)
    expect(r.html).toMatch(/^<!doctype html>/)
    expect(r.html).toContain('<title>')
  })

  it.each(Object.keys(valid))('%s html loads nothing remote and has no script', (template) => {
    const { html } = renderTemplate({ template, vars: valid[template]! })
    expect(html).not.toMatch(/<img|<script|<link|<iframe|@import|url\(|\ssrc=|<style/i)
    // The only external reference allowed is an explicit link the caller passed in.
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    for (const h of hrefs) expect(h).toMatch(/^https:\/\/app\.example\.com\//)
  })

  it('formats cents with grouping and sign', () => {
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(123456789)).toBe('$1,234,567.89')
    expect(formatCents(-250)).toBe('-$2.50')
  })

  it('receipt shows lines, tax, tip, total, paid and balance in cents math', () => {
    const { text, html } = renderTemplate({ template: 'receipt', vars: valid.receipt! })
    expect(text).toContain('Full Detail')
    expect(text).toMatch(/Ceramic add-on\s+\$49\.99/)
    expect(text).toMatch(/Tax\s+\$16\.10/)
    expect(text).toMatch(/Tip\s+\$20\.00/)
    expect(text).toMatch(/Total\s+\$266\.09/)
    expect(text).toMatch(/Balance due\s+\$0\.00/)
    expect(html).toContain('$266.09')
    expect(text).toContain('Oasis Auto Spa')
  })

  it('receipt without a tip omits the tip row', () => {
    const rest = { ...valid.receipt! }
    delete rest.tipCents
    const { text } = renderTemplate({ template: 'receipt', vars: rest })
    expect(text).not.toMatch(/Tip/)
  })

  it('subject override replaces the default', () => {
    expect(
      renderTemplate({ template: 'password_reset', vars: valid.password_reset!, subject: 'Custom' }).subject,
    ).toBe('Custom')
  })
})

describe('variable checking', () => {
  const code = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      expect(e).toBeInstanceOf(EmailError)
      return (e as EmailError).code
    }
    throw new Error('expected throw')
  }

  it('rejects an unknown template', () => {
    expect(code(() => renderTemplate({ template: 'nope', vars: {} }))).toBe('UNKNOWN_TEMPLATE')
  })
  it('rejects a missing required variable', () => {
    const rest = { ...valid.password_reset! }
    delete rest.resetUrl
    expect(code(() => renderTemplate({ template: 'password_reset', vars: rest }))).toBe('MISSING_VAR')
  })
  it('treats an empty string as missing', () => {
    expect(
      code(() =>
        renderTemplate({ template: 'password_reset', vars: { ...valid.password_reset!, resetUrl: '' } }),
      ),
    ).toBe('MISSING_VAR')
  })
  it('rejects unknown variables so typos surface', () => {
    expect(
      code(() =>
        renderTemplate({ template: 'password_reset', vars: { ...valid.password_reset!, resetURL: 'x' } }),
      ),
    ).toBe('UNKNOWN_VAR')
  })
  it('requires integer cents', () => {
    expect(
      code(() => renderTemplate({ template: 'receipt', vars: { ...valid.receipt!, totalCents: 12.5 } })),
    ).toBe('INVALID_VAR')
    expect(
      code(() => renderTemplate({ template: 'receipt', vars: { ...valid.receipt!, totalCents: '1250' } })),
    ).toBe('INVALID_VAR')
  })
  it('rejects non-http(s) and credentialed urls', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://x.example.com/a',
      'https://u:p@x.example.com/',
      'not a url',
    ]) {
      expect(
        code(() =>
          renderTemplate({ template: 'password_reset', vars: { ...valid.password_reset!, resetUrl: bad } }),
        ),
      ).toBe('INVALID_VAR')
    }
  })
  it('rejects malformed receipt items', () => {
    expect(
      code(() => renderTemplate({ template: 'receipt', vars: { ...valid.receipt!, items: 'Wash 12.50' } })),
    ).toBe('INVALID_VAR')
  })
  it('enforces length limits', () => {
    expect(
      code(() =>
        renderTemplate({
          template: 'password_reset',
          vars: { ...valid.password_reset!, recipientName: 'x'.repeat(500) },
        }),
      ),
    ).toBe('INVALID_VAR')
  })
})

describe('escaping and header safety', () => {
  const evil = `<script>alert("x")</script> & 'q'`

  it('escapes every text variable in html, leaves plain text readable', () => {
    const r = renderTemplate({
      template: 'closure_notice',
      vars: { ...valid.closure_notice!, customerName: evil, reason: evil, message: evil, closureLabel: evil },
    })
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;')
    expect(r.text).toContain(evil)
  })

  it('escapes url attributes', () => {
    const r = renderTemplate({
      template: 'password_reset',
      vars: { ...valid.password_reset!, resetUrl: 'https://app.example.com/r?a=1&b=2' },
    })
    expect(r.html).toContain('href="https://app.example.com/r?a=1&amp;b=2"')
  })

  it('escapes receipt line descriptions', () => {
    const items = encodeReceiptItems([{ description: '<b>Wash</b>', cents: 100 }])
    const r = renderTemplate({ template: 'receipt', vars: { ...valid.receipt!, items } })
    expect(r.html).not.toContain('<b>Wash')
    expect(r.html).toContain('&lt;b&gt;Wash&lt;/b&gt;')
  })

  it('cannot inject headers through values that reach the subject', () => {
    const r = renderTemplate({
      template: 'device_alert',
      vars: { ...valid.device_alert!, deviceLabel: 'Tablet\r\nBcc: attacker@example.com' },
    })
    expect(r.subject).not.toMatch(/[\r\n]/)
    const o = renderTemplate({
      template: 'password_reset',
      vars: valid.password_reset!,
      subject: 'Hi\r\nBcc: a@b.c',
    })
    expect(o.subject).not.toMatch(/[\r\n]/)
  })

  it('strips control characters from values', () => {
    const r = renderTemplate({
      template: 'password_reset',
      vars: { ...valid.password_reset!, recipientName: 'Ann\u0000\u0007e' },
    })
    expect(r.text).toContain('Hi Anne,')
  })
})
