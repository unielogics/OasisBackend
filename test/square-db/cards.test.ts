// Cards on file, the shared foundation of waves Q3a and Q3b (ADR 0171 D7, design 4.2): the client's Square customer (link, search by
// reference_id, create with cu_<id>), saving a card with Square and the client's consent (versioned text, hash, snapshot, address,
// browser, link and page), removing it (DisableCard, consents revoked), the migration's rules (consents append-only except the revoke
// columns, purposes, charge states, the card link kind) and watch-only mode.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { simFetch } from '../../src/integrations/square/sim/index.js'
import { issueClientLink } from '../../src/modules/identity/links.js'
import { disableCard, saveCardOnFile, type SaveCardInput, type SquareCardDeps } from '../../src/modules/square/cards.js'
import { consentText, CURRENT_CONSENT_VERSION } from '../../src/modules/square/consents.js'
import { ensureSquareCustomer } from '../../src/modules/square/customers.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { useTestDb } from '../helpers/db.js'
import { makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { silent, squareEnvFor } from './core.js'
import { simFor } from './helpers.js'

const t = useTestDb()
const SESSION_HASH = 'a'.repeat(64)

async function rig(o: { writes?: boolean } = {}) {
  const clock = t.clock as FixedClock
  const newId = createIdGenerator(clock)
  const pe = await setupEnv(t)
  const sim = simFor(clock)
  const api =
    o.writes === false
      ? createSquareApi(
          new SquareClient({ baseUrl: 'http://sim', accessToken: 'sim-token-000001', fetch: simFetch(sim.sim), sleeper: { sleep: async () => undefined }, writesEnabled: false }),
        )
      : sim.api
  const env = squareEnvFor(o.writes === false ? { SQUARE_WRITES_ENABLED: 'false' } : {})
  const deps: SquareCardDeps = { db: t.db, clock, newId, env, api, locationId: pe.locationId, logger: silent }
  const client = (c: { name?: string; email?: string | null; phone?: string | null } = {}) => makeCustomer(t.db, pe, { name: c.name ?? 'Maria Delgado', email: c.email ?? null, phone: c.phone })
  const save = (customerId: string, over: Partial<SaveCardInput> = {}) =>
    saveCardOnFile(deps, {
      customerId,
      sourceId: 'cnon:card-nonce-ok',
      postalCode: '07026',
      cardholderName: 'Maria Delgado',
      purposes: ['no_show_fee', 'late_cancel_fee'],
      consentVersion: CURRENT_CONSENT_VERSION,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (test)',
      linkId: null,
      sessionHash: SESSION_HASH,
      keyBase: `attempt-${customerId}`,
      ...over,
    })
  const calls = (path: string, method = 'POST') => sim.sim.log.filter((r) => r.method === method && r.path === path)
  return { clock, newId, pe, sim, deps, client, save, calls }
}

describe('the consent text', () => {
  it('is the v1 wording, purposes in a fixed order, hashed exactly as shown', () => {
    const c = consentText('v1', ['balance', 'no_show_fee', 'no_show_fee'])
    expect(c.text).toBe(
      'Save this card with Square so Oasis Auto Spa can charge it for: a no-show fee and a balance you owe. ' +
        'Charges are made only after the shop confirms them, except your membership’s monthly payment. ' +
        'You can remove the card any time from your link or by asking us.',
    )
    expect(c.purposes).toEqual(['no_show_fee', 'balance'])
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(consentText('v1', ['membership_billing', 'no_show_fee', 'late_cancel_fee']).text).toContain(
      'charge it for: your membership’s monthly payment, a no-show fee and a late-cancel fee.',
    )
  })

  it('refuses no purpose, an unknown one, and a version that is not the current one', () => {
    expect(() => consentText('v1', [])).toThrow(expect.objectContaining({ code: 'CARD_CONSENT_INVALID' }))
    expect(() => consentText('v1', ['everything'])).toThrow(expect.objectContaining({ code: 'CARD_CONSENT_INVALID' }))
    expect(() => consentText('v0', ['balance'])).toThrow(expect.objectContaining({ code: 'CARD_CONSENT_OUTDATED' }))
    expect(() => consentText('constructor', ['balance'], { anyVersion: true })).toThrow(expect.objectContaining({ code: 'CARD_CONSENT_OUTDATED' }))
  })
})

describe('ensureSquareCustomer', () => {
  it('creates the Square customer once (key cu_<client id>, reference_id the client) and links it', async () => {
    const r = await rig()
    const maria = await r.client({ phone: '+12015550121' })
    const a = await ensureSquareCustomer(r.deps, { customerId: maria })
    expect(a).toMatchObject({ linkedBy: 'created', created: true, emailUpdated: false })
    const sq = r.sim.store.customers.get(a.squareCustomerId)!
    expect(sq).toMatchObject({ given_name: 'Maria', family_name: 'Delgado', reference_id: maria, phone_number: '+12015550121' })
    expect(r.calls('/v2/customers')[0]!.idempotencyKey).toBe(sqKey('cu', maria))
    // the second time: the link, no Square call
    const before = r.sim.sim.log.length
    expect(await ensureSquareCustomer(r.deps, { customerId: maria })).toEqual({ ...a, created: false })
    expect(r.sim.sim.log.length).toBe(before)
    const rows = await t.db.selectFrom('square_customer_links').selectAll().execute()
    expect(rows).toEqual([expect.objectContaining({ customer_id: maria, square_customer_id: a.squareCustomerId, linked_by: 'created', location_id: r.pe.locationId })])
  })

  it('finds the customer an earlier crashed attempt created (SearchCustomers by reference_id) instead of making a second', async () => {
    const r = await rig()
    const maria = await r.client()
    const first = await ensureSquareCustomer(r.deps, { customerId: maria })
    await t.db.deleteFrom('square_customer_links').execute()
    const again = await ensureSquareCustomer(r.deps, { customerId: maria })
    expect(again).toMatchObject({ squareCustomerId: first.squareCustomerId, linkedBy: 'found', created: false })
    expect(r.sim.store.customers.size).toBe(1)
  })

  it('sets the email Square bills to when one is given (never needed for a card)', async () => {
    const r = await rig()
    const maria = await r.client()
    const a = await ensureSquareCustomer(r.deps, { customerId: maria, email: 'maria@oasis-test.dev' })
    expect(a.emailUpdated).toBe(true)
    expect(r.sim.store.customers.get(a.squareCustomerId)!.email_address).toBe('maria@oasis-test.dev')
    expect((await ensureSquareCustomer(r.deps, { customerId: maria, email: 'MARIA@oasis-test.dev' })).emailUpdated).toBe(false)
    expect((await ensureSquareCustomer(r.deps, { customerId: maria, email: 'new@oasis-test.dev' })).emailUpdated).toBe(true)
    expect(r.sim.store.customers.get(a.squareCustomerId)!.email_address).toBe('new@oasis-test.dev')
  })

  it('refuses an unknown or merged client and, watch-only, creates nothing', async () => {
    const r = await rig()
    await expect(ensureSquareCustomer(r.deps, { customerId: r.newId() })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const off = await rig({ writes: false })
    const maria = await off.client()
    await expect(ensureSquareCustomer(off.deps, { customerId: maria })).rejects.toThrow(/writes are off/)
    expect(off.sim.store.customers.size).toBe(0)
    expect(await t.db.selectFrom('square_customer_links').selectAll().execute()).toEqual([])
  })
})

describe('saveCardOnFile', () => {
  it('saves the card with Square (key cd_<keyBase>) and stores the card and the consent, audited', async () => {
    const r = await rig()
    const maria = await r.client()
    const s = await r.save(maria)
    expect(s).toMatchObject({ brand: 'VISA', last4: '5858', expMonth: 10, state: 'active', purposes: ['no_show_fee', 'late_cancel_fee'], consentVersion: 'v1', created: true })
    expect(r.calls('/v2/cards')[0]!.idempotencyKey).toBe(sqKey('cd', `attempt-${maria}`))
    const sqCard = r.sim.store.cards.get(s.squareCardId)!
    expect(sqCard).toMatchObject({ customer_id: s.squareCustomerId, reference_id: maria, cardholder_name: 'Maria Delgado', billing_address: { postal_code: '07026' } })
    const card = await t.db.selectFrom('customer_cards').selectAll().executeTakeFirstOrThrow()
    expect(card).toMatchObject({ id: s.cardId, customer_id: maria, square_card_id: s.squareCardId, brand: 'VISA', last4: '5858', postal: '07026', state: 'active', created_via: 'card_link', disabled_at: null })
    expect(card.fingerprint).toMatch(/^sq-1-/)
    const consent = await t.db.selectFrom('card_consents').selectAll().executeTakeFirstOrThrow()
    const text = consentText('v1', ['no_show_fee', 'late_cancel_fee'])
    expect(consent).toMatchObject({
      id: s.consentId,
      customer_id: maria,
      card_id: s.cardId,
      purposes: ['no_show_fee', 'late_cancel_fee'],
      text_version: 'v1',
      text_sha256: text.sha256,
      text_snapshot: text.text,
      ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0 (test)',
      session_hash: SESSION_HASH,
      revoked_at: null,
    })
    const audit = await t.db.selectFrom('audit_log').select(['action', 'entity_id', 'after']).where('action', 'like', 'card.%').execute()
    expect(audit).toEqual([expect.objectContaining({ action: 'card.saved', entity_id: s.cardId })])
    // the one-time token never reaches the database
    const dump = await sql<{ j: string }>`select concat_ws('|', (select string_agg(row_to_json(c)::text, '') from customer_cards c),
      (select string_agg(row_to_json(k)::text, '') from card_consents k), (select string_agg(row_to_json(a)::text, '') from audit_log a)) as j`.execute(t.db)
    expect(dump.rows[0]!.j).not.toContain('cnon:')
  })

  it('a retry of the same attempt answers the same card and consent: nothing twice', async () => {
    const r = await rig()
    const maria = await r.client()
    const a = await r.save(maria)
    const b = await r.save(maria)
    expect(b).toEqual({ ...a, created: false })
    expect(r.sim.store.cards.size).toBe(1)
    expect(await t.db.selectFrom('customer_cards').select('id').execute()).toHaveLength(1)
    expect(await t.db.selectFrom('card_consents').select('id').execute()).toHaveLength(1)
    // another attempt (another key) saves a second card with its own consent
    const c = await r.save(maria, { keyBase: 'attempt-2', purposes: ['balance'] })
    expect(c.cardId).not.toBe(a.cardId)
    expect(c.purposes).toEqual(['balance'])
    expect(await t.db.selectFrom('card_consents').select('id').execute()).toHaveLength(2)
    // a retry of an attempt whose card was removed meanwhile never brings it back
    await disableCard(r.deps, { cardId: a.cardId, by: 'client' })
    await expect(r.save(maria)).rejects.toMatchObject({ code: 'CARD_NOT_FOUND', detail: 'That card was removed. Enter it again to save it.' })
    expect(await t.db.selectFrom('card_consents').select('id').where('card_id', '=', a.cardId).where('revoked_at', 'is', null).execute()).toEqual([])
  })

  it('two retries of one attempt at the same time store one card and one consent', async () => {
    const r = await rig()
    const maria = await r.client()
    await ensureSquareCustomer(r.deps, { customerId: maria })
    // Square answers both (one after the other, the second from its idempotency store); both transactions then run at once
    let chain: Promise<unknown> = Promise.resolve()
    let arrived = 0
    let release!: () => void
    const both = new Promise<void>((ok) => (release = ok))
    const api = {
      ...r.deps.api,
      cards: {
        ...r.deps.api.cards,
        create: async (...args: Parameters<typeof r.deps.api.cards.create>) => {
          const call = chain.then(() => r.deps.api.cards.create(...args))
          chain = call.catch(() => undefined)
          const card = await call
          if (++arrived === 2) release()
          await both
          return card
        },
      },
    }
    const racing = { ...r.deps, api }
    const save = () => saveCardOnFile(racing, { customerId: maria, sourceId: 'cnon:card-nonce-ok', purposes: ['balance'], consentVersion: 'v1', ip: null, userAgent: null, keyBase: 'race' })
    const [a, b] = await Promise.all([save(), save()])
    expect(a.cardId).toBe(b.cardId)
    expect(a.consentId).toBe(b.consentId)
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect(await t.db.selectFrom('card_consents').select('id').execute()).toHaveLength(1)
  })

  it('checks the consent before sending anything, and a declined card leaves nothing behind', async () => {
    const r = await rig()
    const maria = await r.client()
    await expect(r.save(maria, { consentVersion: 'v0' })).rejects.toMatchObject({ code: 'CARD_CONSENT_OUTDATED' })
    await expect(r.save(maria, { purposes: [] })).rejects.toMatchObject({ code: 'CARD_CONSENT_INVALID' })
    expect(r.sim.sim.log).toEqual([])
    await expect(r.save(maria, { sourceId: 'cnon:card-nonce-declined', keyBase: 'declined' })).rejects.toMatchObject({
      code: 'CARD_DECLINED',
      status: 422,
      detail: 'This card number is not valid. Please check it and try again.',
    })
    expect(await t.db.selectFrom('customer_cards').select('id').execute()).toEqual([])
    expect(await t.db.selectFrom('card_consents').select('id').execute()).toEqual([])
    await expect(r.save(r.newId())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('watch-only answers SQUARE_WRITES_OFF, Square down SQUARE_UNAVAILABLE; nothing is stored', async () => {
    const off = await rig({ writes: false })
    await expect(off.save(await off.client())).rejects.toMatchObject({ code: 'SQUARE_WRITES_OFF', status: 409 })
    const r = await rig()
    const maria = await r.client()
    await ensureSquareCustomer(r.deps, { customerId: maria })
    r.sim.sim.injectFault({ status: 503, times: 20, path: '/v2/cards', method: 'POST' })
    await expect(r.save(maria)).rejects.toMatchObject({ code: 'SQUARE_UNAVAILABLE', status: 503 })
    expect(await t.db.selectFrom('customer_cards').select('id').execute()).toEqual([])
  })
})

describe('disableCard', () => {
  it('disables the card at Square, marks it disabled and revokes its consents; a second call changes nothing', async () => {
    const r = await rig()
    const maria = await r.client()
    const s = await r.save(maria)
    const out = await disableCard(r.deps, { cardId: s.cardId, customerId: maria, by: 'client' })
    expect(out).toEqual({ cardId: s.cardId, state: 'disabled', revokedConsents: 1, alreadyInactive: false })
    expect(r.sim.store.cards.get(s.squareCardId)!.enabled).toBe(false)
    expect(await t.db.selectFrom('customer_cards').select(['state', 'disabled_reason']).executeTakeFirstOrThrow()).toEqual({ state: 'disabled', disabled_reason: 'client_removed' })
    expect(await t.db.selectFrom('card_consents').select(['revoked_by', 'revoke_reason']).executeTakeFirstOrThrow()).toEqual({ revoked_by: 'client', revoke_reason: 'client_removed' })
    const disables = () => r.sim.sim.log.filter((x) => x.method === 'POST' && x.path.endsWith('/disable')).length
    expect(disables()).toBe(1)
    expect(await disableCard(r.deps, { cardId: s.cardId, by: 'staff', actorName: 'Rafael M.' })).toEqual({ cardId: s.cardId, state: 'disabled', revokedConsents: 0, alreadyInactive: true })
    expect(disables()).toBe(1)
    expect((await t.db.selectFrom('audit_log').select('action').where('action', 'like', 'card.%').orderBy('id').execute()).map((a) => a.action)).toEqual(['card.saved', 'card.disabled'])
  })

  it('a page acts only on its own client’s card; watch-only changes nothing', async () => {
    const r = await rig()
    const maria = await r.client()
    const liam = await r.client({ name: 'Liam Ortiz' })
    const s = await r.save(maria)
    await expect(disableCard(r.deps, { cardId: s.cardId, customerId: liam, by: 'client' })).rejects.toMatchObject({ code: 'CARD_NOT_FOUND', status: 404 })
    await expect(disableCard(r.deps, { cardId: r.newId(), by: 'staff' })).rejects.toMatchObject({ code: 'CARD_NOT_FOUND' })
    const off = { ...r.deps, api: createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 'sim-token-000001', fetch: simFetch(r.sim.sim), sleeper: { sleep: async () => undefined }, writesEnabled: false })) }
    await expect(disableCard(off, { cardId: s.cardId, by: 'staff' })).rejects.toMatchObject({ code: 'SQUARE_WRITES_OFF' })
    expect(await t.db.selectFrom('customer_cards').select('state').executeTakeFirstOrThrow()).toEqual({ state: 'active' })
    expect(await t.db.selectFrom('card_consents').select('revoked_at').executeTakeFirstOrThrow()).toEqual({ revoked_at: null })
  })
})

describe('the migration’s rules', () => {
  it('a consent is append-only: no delete, no change but one revoke', async () => {
    const r = await rig()
    const s = await r.save(await r.client())
    await expect(t.db.deleteFrom('card_consents').execute()).rejects.toThrow(/append-only/)
    await expect(t.db.updateTable('card_consents').set({ text_snapshot: 'something else' }).execute()).rejects.toThrow(/append-only/)
    await expect(t.db.updateTable('card_consents').set({ purposes: ['balance'] }).execute()).rejects.toThrow(/append-only/)
    // the revoke needs all three columns
    await expect(t.db.updateTable('card_consents').set({ revoked_at: r.clock.now() }).execute()).rejects.toThrow(/check/)
    await t.db.updateTable('card_consents').set({ revoked_at: r.clock.now(), revoked_by: 'staff', revoke_reason: 'staff_removed' }).execute()
    await expect(t.db.updateTable('card_consents').set({ revoked_by: 'someone else' }).execute()).rejects.toThrow(/revoked consent cannot change/)
    expect(s.consentId).toBeTruthy()
  })

  it('purposes are a non-empty subset of the four; a charge is proposed first and charged only with a Square payment', async () => {
    const r = await rig()
    const maria = await r.client()
    const s = await r.save(maria)
    const consent = (purposes: string[]) =>
      t.db
        .insertInto('card_consents')
        .values({ id: r.newId(), location_id: r.pe.locationId, customer_id: maria, card_id: s.cardId, purposes, text_version: 'v1', text_sha256: 'b'.repeat(64), text_snapshot: 'x', accepted_at: r.clock.now(), ip: null, user_agent: null, link_id: null, session_hash: null, revoked_at: null, revoked_by: null, revoke_reason: null })
        .execute()
    await expect(consent([])).rejects.toThrow(/check/)
    await expect(consent(['balance', 'anything'])).rejects.toThrow(/check/)
    await consent(['membership_billing'])

    const inv = await makeInvoice(t.db, r.pe, { customerId: maria, items: [{ name: 'Signature Hand Wash', priceCents: 4000 }], taxDbp: 0, no: 91001 })
    const charge = (o: { state?: 'proposed' | 'charged' | 'charging'; paymentId?: string | null; decidedAt?: Date | null }) => {
      const id = r.newId()
      return t.db
        .insertInto('square_charges')
        .values({ id, location_id: r.pe.locationId, customer_id: maria, card_id: s.cardId, consent_id: s.consentId, purpose: 'no_show_fee', amount_cents: 2500, state: o.state ?? 'proposed', idempotency_key: sqKey('ch', id), invoice_id: inv.id, square_payment_id: o.paymentId ?? null, decided_at: o.decidedAt ?? null })
        .execute()
    }
    await charge({})
    await expect(charge({ state: 'charged', decidedAt: r.clock.now() })).rejects.toThrow(/check/)
    await expect(charge({ state: 'charging' })).rejects.toThrow(/check/)
    await charge({ state: 'charged', paymentId: 'sq-pay-1', decidedAt: r.clock.now() })
    await expect(charge({ state: 'charged', paymentId: 'sq-pay-1', decidedAt: r.clock.now() })).rejects.toThrow(/unique/)
  })

  it('client_links takes the card kind (a client’s, never a stranger’s)', async () => {
    const r = await rig()
    const maria = await r.client({ phone: '+12015550121' })
    const link = await transaction(t.db, (tx) => issueClientLink(tx, { newId: r.newId, now: r.clock.now() }, { locationId: r.pe.locationId, kind: 'card', customerId: maria, issuedBy: 'staff' }))
    expect(link.url).toBe(`https://oasisautospanj.com/#/k/${link.token}`)
    expect(await t.db.selectFrom('client_links').select(['kind', 'max_uses']).executeTakeFirstOrThrow()).toEqual({ kind: 'card', max_uses: 3 })
    await expect(
      sql`update client_links set customer_id = null`.execute(t.db),
    ).rejects.toThrow(/client_links_customer_check/)
  })
})
