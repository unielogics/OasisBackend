// Review Q4 security:SEC-1: the card-testing lock (3 declined cards a day lock the number) is one lock for every page that sends a
// card to Square: a number locked on the card page cannot send cards through the membership page's subscribe, and cards declined on
// subscribe count toward the lock the card page reads.
import { describe, expect, it } from 'vitest'
import { PHONES, useLinksHarness } from '../public-links/harness.js'
import { json } from '../public-links/harness.js'
import { useSquareMembers } from './rig.js'

const h = useLinksHarness()
const rigOf = useSquareMembers(h)

const cardPosts = (r: ReturnType<typeof rigOf>) => r.sim.sim.log.filter((x) => x.method === 'POST' && x.path === '/v2/cards').length

describe('one card-decline lock for the card page and subscribe (review Q4 SEC-1)', () => {
  it('a number locked by 3 declined cards on the card page is refused by subscribe before anything reaches Square', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    const card = await h.page({ customerId: p.customerId, kind: 'card' })
    expect((await h.verifyByCode(card.session)).statusCode).toBe(200)
    for (let i = 0; i < 3; i++) {
      const d = await h.call('POST', 'cards', {
        session: card.session,
        key: h.nextKey(),
        body: { sourceId: 'cnon:card-nonce-declined', consentVersion: 'v1', purposes: ['no_show_fee'], postalCode: '07026' },
      })
      expect(json(d)).toMatchObject({ code: 'CARD_DECLINED' })
    }
    const before = cardPosts(r)
    const s = await r.subscribe(p.session)
    expect(s.status).toBe(429)
    expect(s.body).toMatchObject({ code: 'CARD_SAVE_LOCKED' })
    expect(cardPosts(r)).toBe(before)
  })

  it('cards declined on subscribe count: after 3 the number is locked on subscribe and on the card page', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    for (let i = 0; i < 3; i++) {
      const d = await r.subscribe(p.session, { sourceId: 'cnon:card-nonce-declined' })
      expect(d.status).toBe(422)
      expect(d.body).toMatchObject({ code: 'CARD_DECLINED' })
    }
    const rows = await h.db.selectFrom('public_rate_limits').select(['key', 'count']).where('key', '=', `card_decline:phone:${PHONES.maria}`).execute()
    expect(rows).toEqual([{ key: `card_decline:phone:${PHONES.maria}`, count: 3 }])
    const before = cardPosts(r)
    expect((await r.subscribe(p.session)).body).toMatchObject({ status: 429, code: 'CARD_SAVE_LOCKED' })
    const card = await h.page({ customerId: p.customerId, kind: 'card' })
    expect((await h.verifyByCode(card.session)).statusCode).toBe(200)
    const locked = await h.call('POST', 'cards', {
      session: card.session,
      key: h.nextKey(),
      body: { sourceId: 'cnon:card-nonce-ok', consentVersion: 'v1', purposes: ['no_show_fee'], postalCode: '07026' },
    })
    expect(locked.statusCode).toBe(429)
    expect(json(locked)).toMatchObject({ code: 'CARD_SAVE_LOCKED' })
    expect(cardPosts(r)).toBe(before)
  })
})
