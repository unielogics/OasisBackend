// The global ceiling on the website's one-time codes (review 2026-10-10): the tablet sends about 30 texts per 30 minutes for the
// whole shop, so the codes strangers can ask for are capped per rolling hour for every caller together (PUBLIC_OTP_TEXTS_PER_HOUR);
// past it the request is refused (429 PUBLIC_CODES_PAUSED, no text, nothing about the number), and the managers are told once.
import { describe, expect, it } from 'vitest'
import { json, PHONES, usePublicHarness } from './harness.js'

const h = usePublicHarness({ env: { PUBLIC_OTP_TEXTS_PER_HOUR: '3' } })
const request = (phone: string) => h.post('public/otp', { phone })
const capNotices = () => h.db.selectFrom('notifications').select(['kind', 'title', 'body']).where('kind', '=', 'public.otp_cap_reached').execute()

describe('the hourly ceiling on website codes', () => {
  it('refuses codes past the ceiling for everyone, queues no text, tells the managers once, and opens again an hour later', async () => {
    // a code that is not sent (suppressed off the allowlist here) does not use the ceiling
    for (const phone of [PHONES.guest, PHONES.member, PHONES.stranger, PHONES.joiner]) expect((await request(phone)).statusCode, phone).toBe(202)
    const over = await request(PHONES.otp)
    expect(over.statusCode).toBe(429)
    expect(json(over)).toMatchObject({ code: 'PUBLIC_CODES_PAUSED', detail: expect.stringMatching(/^We can’t text a code right now\. Try again in \d+ min, or text us\.$/) })
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(3600)
    expect(await h.texts(PHONES.otp)).toEqual([])
    expect(await h.db.selectFrom('public_otp_challenges').select('id').where('phone_e164', '=', PHONES.otp).execute()).toEqual([])
    const notices = await capNotices()
    expect(notices.length).toBeGreaterThan(0)
    expect(new Set(notices.map((n) => n.title))).toEqual(new Set(['Website codes paused: 3 sent in the last hour']))
    // a known number is refused alike (nothing leaks), and the managers are not told again within the hour
    expect((await request(PHONES.extra)).statusCode).toBe(429)
    expect((await request(PHONES.guest)).statusCode).toBe(429)
    expect(await capNotices()).toHaveLength(notices.length)
    h.clock.set('2026-06-13T11:37:00-04:00')
    expect((await request(PHONES.otp)).statusCode).toBe(202)
    expect((await h.texts(PHONES.otp)).map((t) => t.klass)).toEqual(['otp_code'])
  })
})
