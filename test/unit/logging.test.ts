import { describe, expect, it } from 'vitest'
import { createLogger, maskPii, redactUrl } from '../../src/platform/logging.js'

function capture(level = 'info') {
  const lines: Array<Record<string, unknown>> = []
  const log = createLogger(
    { level },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  )
  return { log, lines }
}

describe('maskPii', () => {
  it('masks phone and email fields by key and by value shape', () => {
    expect(
      maskPii({
        phone: '+13055550142',
        email: 'franco@unielogics.com',
        note: 'call +13055550142 or mail a.b@x.io',
      }),
    ).toEqual({
      phone: '+1******0142',
      email: 'f***@unielogics.com',
      note: 'call +1******0142 or mail a***@x.io',
    })
  })
  it('handles to/from only when they look like a phone or email, and nests', () => {
    expect(
      maskPii({
        range: { from: '2026-06-01', to: '2026-06-30' },
        sms: { to: '+13055550142', from: 'x@y.co' },
      }),
    ).toEqual({
      range: { from: '2026-06-01', to: '2026-06-30' },
      sms: { to: '+1******0142', from: 'x***@y.co' },
    })
  })
  it('leaves non-PII values and errors alone', () => {
    const err = new Error('boom')
    expect(maskPii({ id: 7, ok: true, err })).toEqual({ id: 7, ok: true, err })
  })
})

describe('maskText performance', () => {
  it('stays linear on huge strings (no catastrophic backtracking)', () => {
    const start = performance.now()
    maskPii({
      body: 'x'.repeat(2_000_000),
      local: 'a'.repeat(500_000) + '@',
      digits: '+1'.repeat(300_000),
      mixed: 'a@'.repeat(200_000),
    })
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('truncates very long strings and still masks inside the kept part', () => {
    const out = maskPii({ note: `mail me at a.b@x.io ${'y'.repeat(20_000)}` }) as { note: string }
    expect(out.note.startsWith('mail me at a***@x.io yyy')).toBe(true)
    expect(out.note.endsWith('more characters]')).toBe(true)
    expect(out.note.length).toBeLessThan(8300)
  })
})

describe('logger', () => {
  it('redacts secrets at every level', () => {
    const { log, lines } = capture('debug')
    log.debug(
      {
        req: { headers: { authorization: 'Bearer abc', cookie: 'oasis_sid=zzz' } },
        user: { password: 'hunter2', token: 't0k' },
      },
      'x',
    )
    const line = JSON.stringify(lines[0])
    expect(line).not.toContain('Bearer abc')
    expect(line).not.toContain('oasis_sid=zzz')
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('t0k')
    expect(line).toContain('[redacted]')
  })

  it('masks phone and email at info and above but not at debug', () => {
    const info = capture('debug')
    info.log.info({ phone: '+13055550142' }, 'sms to +13055550142')
    info.log.debug({ phone: '+13055550142' }, 'debug detail')
    expect(info.lines[0]).toMatchObject({ phone: '+1******0142', msg: 'sms to +1******0142' })
    expect(info.lines[1]).toMatchObject({ phone: '+13055550142' })
  })

  it('masks PII inside logged errors (message and stack)', () => {
    const { log, lines } = capture('info')
    log.error({ err: new Error('send failed to +13055550142 / franco@unielogics.com') }, 'sms failed')
    const text = JSON.stringify(lines[0])
    expect(text).not.toContain('+13055550142')
    expect(text).not.toContain('franco@')
    expect(text).toContain('+1******0142')
  })

  it('redactUrl hides sensitive query values only', () => {
    expect(redactUrl('/auth/reset?token=abc123&next=%2Fhome')).toBe(
      '/auth/reset?token=%5Bredacted%5D&next=%2Fhome',
    )
    expect(redactUrl('/api/v1/x')).toBe('/api/v1/x')
  })
})
