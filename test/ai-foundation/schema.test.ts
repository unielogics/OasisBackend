// The rules the AI foundation tables enforce themselves (ADR 0160, design section 1): unique token hashes, one pending action per
// phone, one open checkout per membership, the squarespace-only checkout URLs, the category foreign key, the new enum values.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { DEFAULT_CATEGORIES } from '../../src/modules/catalog/categories.js'
import '../../src/modules/identity/schema.js'
import '../../src/modules/assistant/schema.js'
import '../../src/modules/leads/schema.js'
import '../../src/modules/status-texts/schema.js'
import { useTestDb } from '../helpers/db.js'
import { makeAppointment, makeCustomer, makeService, setupLocation, type Fixture } from '../domain-schema/helpers.js'

const t = useTestDb()

const constraintOf = (e: unknown): string | undefined => (e as { constraint?: string }).constraint
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected the statement to fail')
}
const hex = (c: string): string => c.repeat(64)
const PHONE = '+12015550142'
const later = new Date('2026-06-13T15:00:00Z')

async function link(f: Fixture, o: { token: string; kind?: string; customerId?: string | null; invoiceId?: string | null; planKey?: string | null }) {
  return t.db
    .insertInto('client_links')
    .values({
      id: f.newId(),
      location_id: f.locationId,
      token_hash: o.token,
      kind: (o.kind ?? 'calendar') as never,
      customer_id: o.customerId ?? null,
      phone_e164: PHONE,
      invoice_id: o.invoiceId ?? null,
      plan_key: o.planKey ?? null,
      epoch: 1,
      issued_by: 'assistant',
      expires_at: later,
      max_uses: 3,
    })
    .execute()
}

async function conversation(f: Fixture, customerId: string | null = null): Promise<string> {
  const id = f.newId()
  await t.db
    .insertInto('assistant_conversations')
    .values({ id, location_id: f.locationId, phone_e164: PHONE, customer_id: customerId })
    .execute()
  return id
}

describe('catalog categories', () => {
  it('a new location gets the five default categories from ensureDomainDefaults', async () => {
    const f = await setupLocation(t)
    const rows = await t.db.selectFrom('catalog_categories').select(['key', 'label', 'colour', 'sort', 'active']).where('location_id', '=', f.locationId).orderBy('sort').execute()
    expect(rows).toEqual(DEFAULT_CATEGORIES.map((c) => ({ ...c, active: true })))
  })

  it('a service names an existing category of its location, and appointments start with no categories', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f)
    await t.db.updateTable('services').set({ category: 'tint', member_price_cents: 19900, quote_only: true }).where('id', '=', id).execute()
    const e = await failure(t.db.updateTable('services').set({ category: 'ppf' }).where('id', '=', id).execute())
    expect(constraintOf(e)).toBe('services_category_fkey')
    const e2 = await failure(t.db.updateTable('services').set({ vip_inclusion: 'sometimes' as never }).where('id', '=', id).execute())
    expect(constraintOf(e2)).toBe('services_vip_inclusion_check')
    const c = await makeCustomer(t.db, f)
    const a = await makeAppointment(t.db, f, { customerId: c, serviceId: id, start: '2026-06-14T14:00:00Z' })
    const row = await t.db.selectFrom('appointments').select(['categories', 'source']).where('id', '=', a).executeTakeFirstOrThrow()
    expect(row.categories).toEqual([])
    await t.db.updateTable('appointments').set({ categories: ['wash', 'tint'], source: 'sms_ai' }).where('id', '=', a).execute()
  })

  it('a plan checkout URL must be https on squarespace.com', async () => {
    const f = await setupLocation(t)
    const plan = f.newId()
    await sql`insert into membership_plans (id, location_id, key, name, color, bg_color, tint)
      values (${plan}, ${f.locationId}, 'premium', 'Gold', '#fff', '#000', '#111')`.execute(t.db)
    await t.db.updateTable('membership_plans').set({ checkout_url: 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?productId=1', monthly_price_cents: 9900, public_label: 'Gold' }).where('id', '=', plan).execute()
    for (const bad of ['http://oasis.squarespace.com/x', 'https://evil.com/squarespace.com', 'https://squarespace.com.evil.com/'])
      expect(constraintOf(await failure(t.db.updateTable('membership_plans').set({ checkout_url: bad }).where('id', '=', plan).execute()))).toBe(
        'membership_plans_checkout_url_check',
      )
  })
})

describe('identity', () => {
  it('a token hash is unique; PIN, membership and payment links name the client; a stranger may get a calendar link', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    await link(f, { token: hex('a') })
    expect(constraintOf(await failure(link(f, { token: hex('a'), customerId: c })))).toBe('client_links_token_hash_key')
    expect(constraintOf(await failure(link(f, { token: hex('b'), kind: 'pin' })))).toBe('client_links_customer_check')
    expect(constraintOf(await failure(link(f, { token: hex('c'), kind: 'pay', customerId: c })))).toBe('client_links_pay_invoice_check')
    expect(constraintOf(await failure(link(f, { token: hex('d'), kind: 'membership', customerId: c })))).toBe('client_links_membership_plan_check')
    await link(f, { token: hex('e'), kind: 'membership', customerId: c, planKey: 'premium' })
    expect(constraintOf(await failure(link(f, { token: 'not-a-hash' })))).toBe('client_links_token_hash_check')
  })

  it('one pending in-chat action per phone; a settled one leaves room for the next', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const conv = await conversation(f, c)
    const action = (id: string) =>
      t.db
        .insertInto('assistant_pending_actions')
        .values({ id, location_id: f.locationId, conversation_id: conv, customer_id: c, phone_e164: PHONE, kind: 'book', payload: JSON.stringify({ serviceKey: 'signature' }), code_hash: hex('f'), expires_at: later })
        .execute()
    const first = f.newId()
    await action(first)
    expect(constraintOf(await failure(action(f.newId())))).toBe('uq_assistant_pending_actions_phone')
    await t.db.updateTable('assistant_pending_actions').set({ state: 'superseded', resolved_at: later }).where('id', '=', first).execute()
    await action(f.newId())
  })

  it('a phone is trusted once per location; a PIN row keeps its version when cleared', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const trust = () =>
      t.db.insertInto('phone_trust').values({ location_id: f.locationId, phone_e164: PHONE, customer_id: c, verified_at: t.clock.now(), verified_by: 'code', expires_at: later }).execute()
    await trust()
    expect(constraintOf(await failure(trust()))).toBe('phone_trust_pkey')
    await t.db.insertInto('customer_pins').values({ customer_id: c, pin_hash: 'scrypt$1$abcdefghijklmnopqrstuvwxyz', set_at: t.clock.now() }).execute()
    expect(constraintOf(await failure(t.db.updateTable('customer_pins').set({ pin_hash: null }).where('customer_id', '=', c).execute()))).toBe('customer_pins_check')
    await t.db.updateTable('customer_pins').set({ pin_hash: null, cleared_at: t.clock.now(), version: 2 }).where('customer_id', '=', c).execute()
    const cust = await t.db.selectFrom('customers').select(['email_verified', 'phone_version']).where('id', '=', c).executeTakeFirstOrThrow()
    expect(cust).toEqual({ email_verified: false, phone_version: 0 })
  })

  it('a code asked from a link page names its session', async () => {
    const f = await setupLocation(t)
    const otp = (purpose: string, session: string | null) =>
      t.db
        .insertInto('public_otp_challenges')
        .values({ id: f.newId(), location_id: f.locationId, phone_e164: PHONE, code_hash: hex('1'), expires_at: later, purpose: purpose as never, link_session_hash: session })
        .execute()
    expect(constraintOf(await failure(otp('link_verify', null)))).toBe('public_otp_challenges_link_purpose_check')
    await otp('website', null)
  })
})

describe('assistant, leads, status texts, consent', () => {
  it('one conversation per phone, one running turn per conversation', async () => {
    const f = await setupLocation(t)
    const conv = await conversation(f)
    expect(constraintOf(await failure(conversation(f)))).toBe('assistant_conversations_location_id_phone_e164_key')
    const turn = () => t.db.insertInto('assistant_turns').values({ id: f.newId(), conversation_id: conv, trust: 'unknown', provider: 'sim' }).execute()
    await turn()
    expect(constraintOf(await failure(turn()))).toBe('uq_assistant_turns_running')
  })

  it('an AI-created client records the inbound_text opt-in; messages may be written by the AI', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    await t.db.updateTable('customers').set({ sms_opt_in_source: 'inbound_text', source: 'inbound_sms' }).where('id', '=', c).execute()
    await t.db
      .insertInto('messages')
      .values({ id: f.newId(), location_id: f.locationId, customer_id: c, direction: 'out', sender_kind: 'ai', body: 'Hi!', status: 'queued', thread_id: null, employee_id: null, appointment_id: null, sender_employee_id: null, template_key: null, purpose: 'assistant', klass: 'ai_reply', peer_e164: PHONE, encoding: 'GSM-7', idempotency_key: null } as never)
      .execute()
    const e = await failure(sql`update messages set direction = 'in' where sender_kind = 'ai'`.execute(t.db))
    expect(constraintOf(e)).toMatch(/^messages_check/)
  })

  it('one lead per phone; late texts are numbered 1 and 2; a dropped check-in text says why', async () => {
    const f = await setupLocation(t)
    const lead = () =>
      t.db.insertInto('leads').values({ id: f.newId(), location_id: f.locationId, phone_e164: PHONE, source: 'text', interests: ['tint'], first_contact_at: t.clock.now(), last_contact_at: t.clock.now() }).execute()
    await lead()
    expect(constraintOf(await failure(lead()))).toBe('leads_location_id_phone_e164_key')

    const c = await makeCustomer(t.db, f)
    const a = await makeAppointment(t.db, f, { customerId: c, serviceId: await makeService(t.db, f), start: '2026-06-13T14:00:00Z' })
    const late = (seq: number) => t.db.insertInto('appointment_late_texts').values({ appointment_id: a, seq, eta_at: later }).execute()
    await late(1)
    await late(2)
    expect(constraintOf(await failure(late(3)))).toBe('appointment_late_texts_seq_check')
    await t.db.insertInto('pending_checkin_texts').values({ appointment_id: a, location_id: f.locationId, due_at: later }).execute()
    expect(constraintOf(await failure(t.db.updateTable('pending_checkin_texts').set({ state: 'dropped', settled_at: later }).where('appointment_id', '=', a).execute()))).toBe(
      'pending_checkin_texts_check1',
    )
  })
})
