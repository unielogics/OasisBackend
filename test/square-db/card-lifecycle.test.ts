// The life of a saved card after it is saved (ADR 0171 D7, design 4.4, wave Q3a), through the event processor with the core ingest
// handlers and the simulator: the issuer's automatic update copied onto the card; a card disabled or forgotten at Square closed with
// its consents (a card paying a membership: the managers told and the client texted a card link); a card Oasis did not save ignored;
// a Square customer deleted at Square takes its cards and the link; the nightly job texts a card link for a membership card about to
// expire (once) and disables the cards of a deleted client at Square.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { messagingRuntimeFor } from '../../src/composition.js'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { simFetch } from '../../src/integrations/square/sim/index.js'
import { wireEvent } from '../../src/integrations/square/wire.js'
import { runCardNightly } from '../../src/modules/square/card-events.js'
import { saveCardOnFile } from '../../src/modules/square/cards.js'
import type { CardPurpose } from '../../src/modules/square/consents.js'
import { ensureSquareCustomer } from '../../src/modules/square/customers.js'
import { squareCoreIngest } from '../../src/modules/square/handlers.js'
import { processSquareEvent } from '../../src/modules/square/ingest.js'
import { configureSquareRuntime, type SquareQueue } from '../../src/modules/square/runtime.js'
import { useRig } from '../scheduling-gaps/support.js'
import { silent, squareEnvFor } from './core.js'
import { simFor } from './helpers.js'

const PEPPER = '5c1b7e0a9f3d2c6b8a4e1f07d9c2b5a3e6f1d8c4b7a2e9f0c3d6b1a8e5f2c7d4'
const m = useRig({ PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })
afterEach(() => configureSquareRuntime({}))

let r: ReturnType<typeof rig>
function rig() {
  const sim = simFor(m.h.clock)
  const env = squareEnvFor({ PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })
  const queue: SquareQueue = messagingRuntimeFor({ db: m.h.t.db, clock: m.h.clock, env: m.h.t.env }).queue
  configureSquareRuntime({ env, api: () => sim.api, queue })
  const deps = { db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env, api: sim.api, locationId: m.locationId(), logger: silent }
  let n = 0
  const save = (customerId: string, purposes: CardPurpose[] = ['membership_billing', 'no_show_fee']) =>
    saveCardOnFile(deps, { customerId, sourceId: 'cnon:card-nonce-ok', purposes, consentVersion: 'v1', ip: null, userAgent: null, keyBase: `life-${++n}-${customerId}` })
  /** The last event of a type the simulator emitted, through the event processor (as square.event.process runs it). */
  const process = async (type: string) => {
    const rec = [...sim.store.events].reverse().find((e) => e.type === type)
    if (!rec) throw new Error(`no ${type} event`)
    return processSquareEvent({ db: m.h.t.db, clock: m.h.clock, logger: silent, env, api: sim.api, ingest: squareCoreIngest, locationId: m.locationId() }, wireEvent.parse(rec))
  }
  const card = (id: string) => m.h.t.db.selectFrom('customer_cards').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const consents = (cardId: string) => m.h.t.db.selectFrom('card_consents').selectAll().where('card_id', '=', cardId).execute()
  const cardTexts = () =>
    m.h.t.db.selectFrom('messages').select(['body', 'customer_id']).where('template_key', '=', 'personal_link_card').orderBy('queued_at').execute()
  return { sim, env, deps, queue, save, process, card, consents, cardTexts }
}
beforeEach(() => {
  r = rig()
})

describe('card events from Square', () => {
  it('an automatic update copies the new expiry and last 4 onto the saved card (audited); a second delivery changes nothing', async () => {
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria)
    r.sim.store.autoUpdateCard(s.squareCardId, { expYear: 2031, last4: '1111' })
    expect(await r.process('card.automatically_updated')).toEqual({ status: 'processed', note: 'card updated' })
    expect(await r.card(s.cardId)).toMatchObject({ state: 'active', exp_year: 2031, last4: '1111' })
    expect(await r.process('card.automatically_updated')).toEqual({ status: 'processed', note: 'card unchanged' })
    const audits = await m.h.t.db.selectFrom('audit_log').select(['action', 'actor_name']).where('entity_id', '=', s.cardId).where('action', '=', 'card.updated').execute()
    expect(audits).toEqual([{ action: 'card.updated', actor_name: 'Square' }])
  })

  it('a card disabled at Square is closed with its consents; a membership card: the managers are told and the client gets a card link', async () => {
    await m.member('Maria Delgado', 'gold')
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria)
    r.sim.store.disableCard(s.squareCardId)
    const out = await r.process('card.disabled')
    expect(out).toEqual({ status: 'processed', note: 'card disabled, membership card: client texted a card link' })
    expect(await r.card(s.cardId)).toMatchObject({ state: 'disabled', disabled_reason: 'square_disabled' })
    expect(await r.consents(s.cardId)).toEqual([expect.objectContaining({ revoke_reason: 'card_disabled', revoked_by: 'Square' })])
    const texts = await r.cardTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]!.body).toMatch(/^Your saved Visa ending in 5858 can no longer be charged for your membership\. Save a card with Oasis Auto Spa on this secure page: \[private link\]/)
    expect(await m.h.t.db.selectFrom('client_links').select(['kind', 'issued_by']).execute()).toEqual([{ kind: 'card', issued_by: 'system' }])
    const notes = await m.h.t.db.selectFrom('notifications').select(['kind', 'title']).where('kind', '=', 'square.card_removed').execute()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]!.title).toBe('Membership card removed · Maria Delgado')
    // the same event again: nothing more
    expect(await r.process('card.disabled')).toEqual({ status: 'processed', note: 'card already disabled' })
    expect(await r.cardTexts()).toHaveLength(1)
  })

  it('a forgotten card (the holder asked Square) is marked forgotten; a card of a client without a membership texts nothing', async () => {
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria, ['no_show_fee'])
    await r.sim.sim.handle({ method: 'POST', path: `/__sim/cards/${encodeURIComponent(s.squareCardId)}/forget`, query: new URLSearchParams(), headers: {}, body: {} })
    expect(await r.process('card.forgotten')).toEqual({ status: 'processed', note: 'card forgotten' })
    expect(await r.card(s.cardId)).toMatchObject({ state: 'forgotten', disabled_reason: 'square_forgotten' })
    expect(await r.consents(s.cardId)).toEqual([expect.objectContaining({ revoke_reason: 'card_forgotten' })])
    expect(await r.cardTexts()).toEqual([])
  })

  it('a card Oasis did not save is ignored', async () => {
    const sqCustomer = r.sim.store.createCustomer({ given_name: 'Walk', family_name: 'In' })
    r.sim.store.createCard({ source_id: 'cnon:card-nonce-ok', card: { customer_id: sqCustomer.id } })
    expect(await r.process('card.created')).toEqual({ status: 'ignored', note: 'a card Oasis did not save' })
    expect(await m.h.t.db.selectFrom('customer_cards').select('id').execute()).toEqual([])
  })

  it('a Square customer deleted at Square closes its cards and the link; the next save makes a new Square customer', async () => {
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria, ['no_show_fee'])
    r.sim.store.deleteCustomer(s.squareCustomerId)
    expect(await r.process('customer.deleted')).toEqual({ status: 'processed', note: 'Square customer deleted: 1 card(s) closed' })
    expect(await r.card(s.cardId)).toMatchObject({ state: 'disabled', disabled_reason: 'square_disabled' })
    expect(await m.h.t.db.selectFrom('square_customer_links').select('id').execute()).toEqual([])
    const again = await ensureSquareCustomer(r.deps, { customerId: maria })
    expect(again).toMatchObject({ created: true, linkedBy: 'created' })
    expect(again.squareCustomerId).not.toBe(s.squareCustomerId)
  })
})

describe('square.cards.nightly', () => {
  it('texts a card link once for a membership card that expires within 30 days', async () => {
    await m.member('Maria Delgado', 'gold')
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria)
    // today is Jun 13, 2026: a card good through June expires within 30 days, one good through August does not
    await m.h.t.db.updateTable('customer_cards').set({ exp_month: 8, exp_year: 2026 }).where('id', '=', s.cardId).execute()
    expect(await runCardNightly({ ...r.deps, queue: r.queue })).toMatchObject({ texted: 0 })
    await m.h.t.db.updateTable('customer_cards').set({ exp_month: 6, exp_year: 2026 }).where('id', '=', s.cardId).execute()
    expect(await runCardNightly({ ...r.deps, queue: r.queue })).toMatchObject({ texted: 1, notTexted: 0 })
    const texts = await r.cardTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]!.body).toMatch(/^Your Visa ending in 5858 on file for your membership expires soon\. Save a card with Oasis Auto Spa on this secure page: \[private link\]/)
    expect((await r.card(s.cardId)).expiry_notice_for).toBe('2026-06')
    expect(await runCardNightly({ ...r.deps, queue: r.queue })).toMatchObject({ texted: 0 })
    expect(await r.cardTexts()).toHaveLength(1)
  })

  it('a card that pays no membership gets no text; with personal links off nothing is issued', async () => {
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria, ['no_show_fee'])
    await m.h.t.db.updateTable('customer_cards').set({ exp_month: 6, exp_year: 2026 }).where('id', '=', s.cardId).execute()
    expect(await runCardNightly({ ...r.deps, queue: r.queue })).toMatchObject({ texted: 0, notTexted: 0 })
    await m.member('Maria Delgado', 'gold')
    await r.save(maria)
    await m.h.t.db.updateTable('customer_cards').set({ exp_month: 6, exp_year: 2026 }).execute()
    const off = squareEnvFor({ PUBLIC_LINKS_ENABLED: 'false' })
    expect(await runCardNightly({ ...r.deps, env: off, queue: r.queue })).toMatchObject({ texted: 0, notTexted: 1 })
    expect(await m.h.t.db.selectFrom('client_links').select('id').execute()).toEqual([])
  })

  it('disables the cards of a deleted client at Square (consents revoked customer_deleted)', async () => {
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria, ['no_show_fee'])
    await m.h.t.db.updateTable('customers').set({ deleted_at: m.h.clock.now() }).where('id', '=', maria).execute()
    expect(await runCardNightly({ ...r.deps, queue: r.queue })).toMatchObject({ disabled: 1, disableFailed: 0 })
    expect(await r.card(s.cardId)).toMatchObject({ state: 'disabled', disabled_reason: 'customer_deleted' })
    expect(await r.consents(s.cardId)).toEqual([expect.objectContaining({ revoke_reason: 'customer_deleted' })])
    expect(r.sim.store.cards.get(s.squareCardId)!.enabled).toBe(false)
    expect(await runCardNightly({ ...r.deps, queue: r.queue })).toMatchObject({ disabled: 0 })
  })

  it('watch-only: a deleted client’s card waits for the next night (nothing changes)', async () => {
    const maria = await m.customer('Maria Delgado')
    const s = await r.save(maria, ['no_show_fee'])
    await m.h.t.db.updateTable('customers').set({ deleted_at: m.h.clock.now() }).where('id', '=', maria).execute()
    const watch = squareEnvFor({ SQUARE_WRITES_ENABLED: 'false' })
    const api = createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 'sim-token-000001', fetch: simFetch(r.sim.sim), sleeper: { sleep: async () => undefined }, writesEnabled: false }))
    expect(await runCardNightly({ ...r.deps, env: watch, api, queue: r.queue })).toMatchObject({ disabled: 0, disableFailed: 1 })
    expect(await r.card(s.cardId)).toMatchObject({ state: 'active' })
  })
})
