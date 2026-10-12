// The card page (#/k, ADR 0171 D7 and D12, wave Q3a; design 4.2): a card link page with a FRESH PIN or code saves a card with Square
// (the SDK's one-time token, the client's consent: the current wording and the purposes ticked, the box unchecked by default), lists
// the client's saved cards, and removes one; the limits (per address, per number, per page) and the number locked for the day after
// 3 declined cards; the consent checks (an outdated or unknown version, nothing ticked, an unknown purpose); off before the cutover.
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { coreVars } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'
import { DAY, json, PHONES, useLinksHarness } from './harness.js'

const h = useLinksHarness()
// the harness deletes its clients before each test: the card rows that name them go first
afterEach(async () => {
  configureSquareRuntime({})
  await sql`truncate table square_charges, card_consents, customer_cards, square_customer_links restart identity cascade`.execute(h.db)
})

function square(vars: Record<string, string> = {}) {
  const sim = simFor(h.clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test', ...vars })
  configureSquareRuntime({ env, api: () => sim.api })
  return { sim, env }
}

const BODY = { sourceId: 'cnon:card-nonce-ok', consentVersion: 'v1', purposes: ['no_show_fee', 'late_cancel_fee'], postalCode: '07026', cardholderName: 'Maria Delgado' }

/** A card page of a client, verified now by a texted code (fresh). */
async function cardPage(o: { createdAt?: Date } = {}) {
  const id = await h.customer(o.createdAt ? { createdAt: o.createdAt } : {})
  const page = await h.page({ customerId: id, kind: 'card' })
  const v = await h.verifyByCode(page.session)
  expect(v.statusCode, v.body).toBe(200)
  return { id, ...page }
}

const save = (session: string, body: Record<string, unknown> = BODY, key = h.nextKey(), ip?: string) =>
  h.call('POST', 'cards', { session, body, key, ...(ip ? { ip } : {}) })
const stored = async () => ({
  cards: await h.db.selectFrom('customer_cards').selectAll().execute(),
  consents: await h.db.selectFrom('card_consents').selectAll().execute(),
})

describe('POST /public/links/cards', () => {
  it('saves the card with Square and the consent (version, hash, text, address, browser, link, page); one completion of the link', async () => {
    const s = square()
    const p = await cardPage()
    const r = await save(p.session)
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toEqual({
      card: { id: expect.any(String), brand: 'VISA', last4: '5858', expMonth: 10, expYear: expect.any(Number), state: 'active' },
      consent: { version: 'v1', purposes: ['no_show_fee', 'late_cancel_fee'] },
    })
    const { cards, consents } = await stored()
    expect(cards).toEqual([expect.objectContaining({ customer_id: p.id, created_via: 'card_link', state: 'active', postal: '07026' })])
    expect(consents).toEqual([
      expect.objectContaining({
        card_id: cards[0]!.id,
        purposes: ['no_show_fee', 'late_cancel_fee'],
        text_version: 'v1',
        text_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        link_id: p.link.id,
        session_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        ip: expect.stringMatching(/^10\.91\./),
        user_agent: expect.any(String),
        revoked_at: null,
      }),
    ])
    expect(consents[0]!.text_snapshot).toContain('charge it for: a no-show fee and a late-cancel fee.')
    expect([...s.sim.store.cards.values()]).toEqual([expect.objectContaining({ reference_id: p.id, cardholder_name: 'Maria Delgado' })])
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', p.link.id).executeTakeFirstOrThrow()).uses).toBe(1)
    // the page now lists it, with what the client agreed to
    const me = json(await h.call('GET', 'me', { session: p.session }))
    expect(me.cards).toEqual([{ id: cards[0]!.id, brand: 'VISA', last4: '5858', expMonth: 10, expYear: expect.any(Number), purposes: ['no_show_fee', 'late_cancel_fee'] }])
    expect(me.cardSetup).toMatchObject({
      consent: { version: 'v1', checkedByDefault: false, purposes: expect.arrayContaining([{ key: 'balance', words: 'a balance you owe' }]) },
      square: { applicationId: 'sandbox-sq0idb-test', locationId: 'LSIMTEST0001', environment: 'sandbox', sdkUrl: 'https://sandbox.web.squarecdn.com/v1/square.js' },
    })
    expect(me.cardSetup.consent.text).toContain('{purposes}')
  })

  it('a retry with the same key answers the stored card: one card at Square, one completion', async () => {
    const s = square()
    const p = await cardPage()
    const key = h.nextKey()
    const first = await save(p.session, BODY, key)
    const again = await save(p.session, BODY, key)
    expect(first.statusCode).toBe(201)
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(json(again)).toEqual(json(first))
    expect(s.sim.store.cards.size).toBe(1)
    expect((await stored()).consents).toHaveLength(1)
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', p.link.id).executeTakeFirstOrThrow()).uses).toBe(1)
  })

  it('needs a fresh PIN or code on a card page of the client (not the number’s trust alone, not another kind of page)', async () => {
    square()
    const id = await h.customer()
    await h.trust(id)
    const trusted = await h.page({ customerId: id, kind: 'card' })
    expect(trusted.body.trust.verified).toBe(true)
    const r = await save(trusted.session)
    expect(r.statusCode).toBe(403)
    expect(json(r)).toMatchObject({ code: 'IDENTITY_STEP_UP_REQUIRED', meta: { need: 'fresh' } })
    const cal = await h.page({ customerId: id, kind: 'calendar' })
    await h.verifyByCode(cal.session)
    const wrong = await save(cal.session)
    expect(wrong.statusCode).toBe(401)
    expect(json(wrong).code).toBe('LINK_WRONG_PURPOSE')
    // the fresh step-up lasts 5 minutes
    const p = await h.page({ customerId: id, kind: 'card' })
    await h.verifyByCode(p.session)
    h.advance(6 * 60_000)
    expect((await save(p.session)).statusCode).toBe(403)
    expect(await stored()).toEqual({ cards: [], consents: [] })
  })

  it('a code does not prove a stale record: 409 IDENTITY_RECORD_UNCONFIRMED, nothing saved', async () => {
    square()
    const p = await cardPage({ createdAt: new Date(h.clock.now().getTime() - 200 * DAY) })
    const r = await save(p.session)
    expect(r.statusCode).toBe(409)
    expect(json(r).code).toBe('IDENTITY_RECORD_UNCONFIRMED')
    expect(await stored()).toEqual({ cards: [], consents: [] })
  })

  it('checks the consent before anything goes to Square: an outdated version, nothing ticked, an unknown purpose', async () => {
    const s = square()
    const p = await cardPage()
    const old = await save(p.session, { ...BODY, consentVersion: 'v0' })
    expect(old.statusCode).toBe(409)
    expect(json(old)).toMatchObject({ code: 'CARD_CONSENT_OUTDATED', detail: 'The card terms were updated. Reload the page, read them and try again.' })
    const unchecked = await save(p.session, { ...BODY, purposes: [] })
    expect(unchecked.statusCode).toBe(422)
    const unknown = await save(p.session, { ...BODY, purposes: ['everything'] })
    expect(unknown.statusCode).toBe(422)
    expect(await stored()).toEqual({ cards: [], consents: [] })
    expect(s.sim.store.customers.size).toBe(0)
    expect(s.sim.sim.log.filter((x) => x.path === '/v2/cards')).toEqual([])
  })

  it('a declined card answers in plain words; 3 declines lock the number for the day', async () => {
    const s = square()
    const p = await cardPage()
    for (let i = 0; i < 3; i++) {
      const r = await save(p.session, { ...BODY, sourceId: 'cnon:card-nonce-declined' })
      expect(r.statusCode).toBe(422)
      expect(json(r)).toMatchObject({ code: 'CARD_DECLINED', detail: 'This card number is not valid. Please check it and try again.' })
    }
    const page2 = await h.page({ customerId: p.id, kind: 'card' })
    await h.verifyByCode(page2.session)
    const locked = await save(page2.session)
    expect(locked.statusCode).toBe(429)
    expect(json(locked)).toMatchObject({ code: 'CARD_SAVE_LOCKED', detail: 'Too many cards were declined on this number today. Try again tomorrow, or pay at the shop.' })
    expect(await stored()).toEqual({ cards: [], consents: [] })
    expect(s.sim.store.cards.size).toBe(0)
  })

  it('limits a page to 3 tries a day (and a number to 5)', async () => {
    square()
    const p = await cardPage()
    for (let i = 0; i < 3; i++) expect((await save(p.session, { ...BODY, consentVersion: 'v0' })).statusCode).toBe(409)
    const fourth = await save(p.session)
    expect(fourth.statusCode).toBe(429)
    expect(json(fourth).code).toBe('PUBLIC_RATE_LIMITED')
    const other = await h.page({ customerId: p.id, kind: 'card' })
    await h.verifyByCode(other.session)
    // the refused fourth try counted for the number too: this is its fifth, then its sixth of the day
    expect((await save(other.session, { ...BODY, consentVersion: 'v0' })).statusCode).toBe(409)
    const sixth = await save(other.session)
    expect(sixth.statusCode).toBe(429)
    expect(json(sixth).code).toBe('PUBLIC_RATE_LIMITED')
  })

  it('is not ready before the cutover (501 LINK_ACTION_NOT_READY) and refused watch-only (409 SQUARE_WRITES_OFF): nothing saved', async () => {
    square({ PAYMENT_PROCESSOR: 'squarespace' })
    const p = await cardPage()
    const r = await save(p.session)
    expect(r.statusCode).toBe(501)
    expect(json(r).code).toBe('LINK_ACTION_NOT_READY')
    expect(json(await h.call('GET', 'me', { session: p.session })).cardSetup).toBeNull()
    square({ SQUARE_WRITES_ENABLED: 'false' })
    const w = await save(p.session)
    expect(w.statusCode).toBe(409)
    expect(json(w).code).toBe('SQUARE_WRITES_OFF')
    expect(await stored()).toEqual({ cards: [], consents: [] })
  })
})

describe('DELETE /public/links/cards/:cardId and the page’s list', () => {
  it('removes one of the page client’s own cards (DisableCard, consents revoked); another client’s card is not found', async () => {
    const s = square()
    const p = await cardPage()
    const saved = json(await save(p.session))
    const other = await h.customer({ name: 'Liam Chen', phone: PHONES.liam })
    const otherCard = await h.page({ customerId: other, kind: 'card' })
    await h.verifyByCode(otherCard.session)
    const theirs = json(await save(otherCard.session))
    const nope = await h.call('DELETE', `cards/${theirs.card.id}`, { session: p.session })
    expect(nope.statusCode).toBe(404)
    expect(json(nope).code).toBe('CARD_NOT_FOUND')
    const r = await h.call('DELETE', `cards/${saved.card.id}`, { session: p.session })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toEqual({ cardId: saved.card.id, state: 'disabled' })
    const row = await h.db.selectFrom('customer_cards').selectAll().where('id', '=', saved.card.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ state: 'disabled', disabled_reason: 'client_removed' })
    expect(s.sim.store.cards.get(row.square_card_id)!.enabled).toBe(false)
    const k = await h.db.selectFrom('card_consents').selectAll().where('card_id', '=', saved.card.id).executeTakeFirstOrThrow()
    expect(k).toMatchObject({ revoke_reason: 'client_removed', revoked_by: 'client' })
    expect(json(await h.call('GET', 'me', { session: p.session })).cards).toEqual([])
    // the other client's card is untouched
    expect((await h.db.selectFrom('customer_cards').select('state').where('id', '=', theirs.card.id).executeTakeFirstOrThrow()).state).toBe('active')
  })

  it('needs a fresh PIN or code too', async () => {
    square()
    const p = await cardPage()
    const saved = json(await save(p.session))
    h.advance(6 * 60_000)
    const r = await h.call('DELETE', `cards/${saved.card.id}`, { session: p.session })
    expect(r.statusCode).toBe(403)
    expect((await h.db.selectFrom('customer_cards').select('state').executeTakeFirstOrThrow()).state).toBe('active')
  })

  it('the cards are listed only on verified card and membership pages', async () => {
    square()
    const p = await cardPage()
    await save(p.session)
    // the code entered above trusted the number for 30 days: without that trust a new page starts unverified
    await sql`delete from phone_trust`.execute(h.db)
    const fresh = await h.page({ customerId: p.id, kind: 'card' })
    expect(fresh.body.trust.verified).toBe(false)
    expect(fresh.body.cards).toBeNull()
    expect(fresh.body.cardSetup).not.toBeNull()
    await h.trust(p.id)
    const cal = await h.page({ customerId: p.id, kind: 'calendar' })
    expect(cal.body.trust.verified).toBe(true)
    expect(cal.body.cards).toBeNull()
    expect(cal.body.cardSetup).toBeNull()
    const verified = await h.page({ customerId: p.id, kind: 'card' })
    expect(verified.body.cards).toHaveLength(1)
  })
})
