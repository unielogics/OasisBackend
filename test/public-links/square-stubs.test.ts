// The card link kind and the declared-only Square routes of the link pages (wave Q3 shared foundation, ADR 0171 D7 and D8): a `card`
// link (#/k, 24 h, 3 uses, fresh PIN or code for its action) opens like any other link and its page says `kind: card`; the card and
// Square membership routes exist (contract, OpenAPI, authz matrix) but do nothing yet: 501 LINK_ACTION_NOT_READY once a page is open,
// and nothing is written.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { LINK_POLICY } from '../../src/modules/identity/links.js'
import { renderTemplate } from '../../src/modules/messaging/templates/render.js'
import { json, useLinksHarness } from './harness.js'

const h = useLinksHarness()
const HOUR = 60 * 60_000

describe('the card link kind', () => {
  it('is issued for a client with the #/k URL, 24 hours and 3 uses, and its page opens as kind card', async () => {
    expect(LINK_POLICY.card).toEqual({ ttlMs: 24 * HOUR, maxUses: 3, maxExchanges: 20, path: 'k', fresh: true })
    expect(Object.entries(LINK_POLICY).filter(([, p]) => p.fresh).map(([k]) => k).sort()).toEqual(['card', 'membership', 'pay'])
    const id = await h.customer()
    const link = await h.link({ customerId: id, kind: 'card' })
    expect(link.url).toBe(`https://oasisautospanj.com/#/k/${link.token}`)
    expect(link.maxUses).toBe(3)
    expect(link.expiresAt.getTime() - h.clock.now().getTime()).toBe(24 * HOUR)
    const page = await h.open(link.token)
    expect(page.res.statusCode).toBe(200)
    expect(page.body).toMatchObject({ kind: 'card', invoice: null, plan: null })
  })

  it('is refused for a stranger (a card is always a client’s)', async () => {
    await expect(h.link({ customerId: null, kind: 'card', phone: '+12015550123' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('has its own text, which carries the link', () => {
    const text = renderTemplate('personal_link_card', { link: 'https://oasisautospanj.com/#/k/TOKEN' }).text
    expect(text).toBe('Save a card with Oasis Auto Spa on this secure page: https://oasisautospanj.com/#/k/TOKEN It expires in 24 hours.')
  })
})

describe('Square routes declared for waves Q3a and Q3b', () => {
  const CALLS: ['GET' | 'POST' | 'DELETE', string, unknown][] = [
    ['POST', 'cards', { sourceId: 'cnon:card-nonce-ok', consentVersion: 'v1', purposes: ['no_show_fee'] }],
    ['DELETE', 'cards/00000000-0000-4000-8000-000000000001', undefined],
    ['POST', 'membership/subscribe', { email: 'maria@example.com', sourceId: 'cnon:card-nonce-ok', consentVersion: 'v1' }],
    ['GET', 'membership/status', undefined],
  ]

  it('answer 501 LINK_ACTION_NOT_READY on an open page and write nothing', async () => {
    const id = await h.customer()
    const { session } = await h.page({ customerId: id, kind: 'card' })
    for (const [method, path, body] of CALLS) {
      const r = await h.call(method, path, { session, body, key: h.nextKey() })
      expect(r.statusCode, `${method} ${path} ${r.body}`).toBe(501)
      expect(json(r)).toMatchObject({ code: 'LINK_ACTION_NOT_READY', status: 501 })
      expect(r.headers['cache-control'], path).toBe('no-store')
    }
    const counts = await sql<{ n: number }>`select
      (select count(*)::int from square_customer_links) + (select count(*)::int from customer_cards)
      + (select count(*)::int from card_consents) + (select count(*)::int from square_charges) as n`.execute(h.db)
    expect(counts.rows[0]!.n).toBe(0)
  })

  it('validate their bodies first (the contract the next waves start from)', async () => {
    const id = await h.customer()
    const { session } = await h.page({ customerId: id, kind: 'card' })
    const bad = await h.call('POST', 'cards', { session, body: { sourceId: 'cnon:card-nonce-ok', consentVersion: 'v1', purposes: [] } })
    expect(bad.statusCode).toBe(422)
    const extra = await h.call('POST', 'cards', { session, body: { sourceId: 'x', consentVersion: 'v1', purposes: ['balance'], pan: '4111' } })
    expect(extra.statusCode).toBe(422)
    const notUuid = await h.call('DELETE', 'cards/abc', { session })
    expect(notUuid.statusCode).toBe(422)
  })
})
