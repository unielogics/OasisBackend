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

async function link(f: Fixture, o: { token: string; kind?: string; customerId?: string | null; invoiceId?: string | null; planKey?: string | null; expiresAt?: Date }) {
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
      expires_at: o.expiresAt ?? later,
      max_uses: 3,
    })
    .execute()
}

async function plan(f: Fixture, key: string): Promise<string> {
  const id = f.newId()
  await sql`insert into membership_plans (id, location_id, key, name, color, bg_color, tint)
    values (${id}, ${f.locationId}, ${key}, ${key}, '#fff', '#000', '#111')`.execute(t.db)
  return id
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
    // the plan must exist at that location
    expect(constraintOf(await failure(link(f, { token: hex('e'), kind: 'membership', customerId: c, planKey: 'premium' })))).toBe('client_links_plan_fkey')
    await plan(f, 'premium')
    await link(f, { token: hex('e'), kind: 'membership', customerId: c, planKey: 'premium' })
    expect(constraintOf(await failure(link(f, { token: 'not-a-hash' })))).toBe('client_links_token_hash_check')
  })

  it('a link expires after it was made', async () => {
    const f = await setupLocation(t)
    expect(constraintOf(await failure(link(f, { token: hex('1'), expiresAt: t.clock.now() })))).toBe('client_links_expiry_check')
    expect(constraintOf(await failure(link(f, { token: hex('2'), expiresAt: new Date(t.clock.now().getTime() - 1000) })))).toBe('client_links_expiry_check')
    await link(f, { token: hex('3'), expiresAt: new Date(t.clock.now().getTime() + 1000) })
  })

  it('a pending action never counts more attempts than it allows', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const conv = await conversation(f, c)
    const id = f.newId()
    await t.db
      .insertInto('assistant_pending_actions')
      .values({ id, location_id: f.locationId, conversation_id: conv, customer_id: c, phone_e164: PHONE, kind: 'cancel', payload: JSON.stringify({}), code_hash: hex('f'), expires_at: later, max_attempts: 3 })
      .execute()
    await t.db.updateTable('assistant_pending_actions').set({ attempts: 3 }).where('id', '=', id).execute()
    expect(constraintOf(await failure(t.db.updateTable('assistant_pending_actions').set({ attempts: 4 }).where('id', '=', id).execute()))).toBe(
      'assistant_pending_actions_attempts_max_check',
    )
  })

  it('phone trust lasts at most 30 days from the verification', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const at = t.clock.now()
    const day = 86_400_000
    const trust = (phone: string, expires: Date) =>
      t.db.insertInto('phone_trust').values({ location_id: f.locationId, phone_e164: phone, customer_id: c, verified_at: at, verified_by: 'pin', expires_at: expires }).execute()
    await trust('+12015550101', new Date(at.getTime() + 30 * day))
    await trust('+12015550102', new Date(at.getTime() + 30 * day + 60_000)) // a minute of slack
    expect(constraintOf(await failure(trust('+12015550103', new Date(at.getTime() + 31 * day))))).toBe('phone_trust_window_check')
    expect(constraintOf(await failure(trust('+12015550104', at)))).toBe('phone_trust_window_check')
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

  it('a code asked from a link page names its session; deleting the session or the link keeps the code row (the hourly ceiling counts it)', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    await link(f, { token: hex('7'), customerId: c })
    const linkId = (await t.db.selectFrom('client_links').select('id').where('token_hash', '=', hex('7')).executeTakeFirstOrThrow()).id
    const session = hex('8')
    await t.db
      .insertInto('client_link_sessions')
      .values({ token_hash: session, link_id: linkId, customer_id: c, phone_e164: PHONE, idle_expires_at: later, expires_at: later })
      .execute()
    // one live code per phone: each earlier one is superseded (the rows stay, which is the point)
    const otp = (purpose: string, s: string | null) => {
      const id = f.newId()
      return t.db
        .insertInto('public_otp_challenges')
        .values({ id, location_id: f.locationId, phone_e164: PHONE, code_hash: hex('1'), expires_at: later, purpose: purpose as never, link_session_hash: s, consumed_at: t.clock.now(), consumed_reason: 'superseded' })
        .execute()
        .then(() => id)
    }
    // a website code never names a link session
    expect(constraintOf(await failure(otp('website', session)))).toBe('public_otp_challenges_link_purpose_check')
    await otp('website', null)
    const fromLink = await otp('link_verify', session)
    const pinSet = await otp('pin_set', session)
    await t.db.deleteFrom('client_link_sessions').where('token_hash', '=', session).execute()
    const kept = await t.db.selectFrom('public_otp_challenges').select(['id', 'purpose', 'link_session_hash']).where('id', 'in', [fromLink, pinSet]).orderBy('id').execute()
    expect(kept).toEqual([
      { id: fromLink, purpose: 'link_verify', link_session_hash: null },
      { id: pinSet, purpose: 'pin_set', link_session_hash: null },
    ])
    // and through the link's own cascade to its sessions
    await t.db
      .insertInto('client_link_sessions')
      .values({ token_hash: hex('9'), link_id: linkId, customer_id: c, phone_e164: PHONE, idle_expires_at: later, expires_at: later })
      .execute()
    const third = await otp('pin_reset', hex('9'))
    await t.db.deleteFrom('client_links').where('id', '=', linkId).execute()
    expect((await t.db.selectFrom('public_otp_challenges').select('link_session_hash').where('id', '=', third).executeTakeFirstOrThrow()).link_session_hash).toBeNull()
    expect(Number((await t.db.selectFrom('public_otp_challenges').select((eb) => eb.fn.countAll().as('n')).where('phone_e164', '=', PHONE).executeTakeFirstOrThrow()).n)).toBe(4)
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

describe('memberships started through a link', () => {
  async function membership(f: Fixture, customerId: string, planId: string): Promise<string> {
    const id = f.newId()
    await sql`insert into memberships (id, location_id, customer_id, plan_id, plan_label, status, source, started_at)
      values (${id}, ${f.locationId}, ${customerId}, ${planId}, 'Gold', 'pending', 'manual', ${t.clock.now()})`.execute(t.db)
    return id
  }
  const checkout = (f: Fixture, o: { membershipId: string; customerId: string; planKey: string }) =>
    t.db
      .insertInto('membership_checkouts')
      .values({
        id: f.newId(),
        location_id: f.locationId,
        membership_id: o.membershipId,
        customer_id: o.customerId,
        plan_key: o.planKey,
        checkout_url: 'https://oasis.squarespace.com/checkout/subscribe?productId=1',
        started_at: t.clock.now(),
        expires_at: later,
      })
      .execute()

  it('a checkout names an existing plan and the membership\'s own client, and follows the membership to a merged client', async () => {
    const f = await setupLocation(t)
    const maria = await makeCustomer(t.db, f)
    const david = await makeCustomer(t.db, f, { name: 'David Okafor' })
    const gold = await plan(f, 'premium')
    const m = await membership(f, maria, gold)
    expect(constraintOf(await failure(checkout(f, { membershipId: m, customerId: maria, planKey: 'platinum' })))).toBe('membership_checkouts_plan_fkey')
    expect(constraintOf(await failure(checkout(f, { membershipId: m, customerId: david, planKey: 'premium' })))).toBe('membership_checkouts_membership_customer_fkey')
    await checkout(f, { membershipId: m, customerId: maria, planKey: 'premium' })
    // a merge moves the membership: its checkouts move with it
    await t.db.updateTable('memberships').set({ customer_id: david }).where('id', '=', m).execute()
    expect((await t.db.selectFrom('membership_checkouts').select('customer_id').where('membership_id', '=', m).executeTakeFirstOrThrow()).customer_id).toBe(david)
    // renaming a plan key carries the links and checkouts along
    await t.db.updateTable('membership_plans').set({ key: 'executive' }).where('id', '=', gold).execute()
    expect((await t.db.selectFrom('membership_checkouts').select('plan_key').where('membership_id', '=', m).executeTakeFirstOrThrow()).plan_key).toBe('executive')
  })
})

describe('the AI pause on a thread', () => {
  it('names who paused it only together with until when', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const thread = f.newId()
    await t.db.insertInto('message_threads').values({ id: thread, location_id: f.locationId, customer_id: c }).execute()
    const emp = f.newId()
    await sql`insert into employees (id, first) values (${emp}, 'Gerald')`.execute(t.db)
    expect(constraintOf(await failure(t.db.updateTable('message_threads').set({ ai_paused_by: emp }).where('id', '=', thread).execute()))).toBe('message_threads_ai_pause_check')
    await t.db.updateTable('message_threads').set({ ai_paused_by: emp, ai_paused_until: later }).where('id', '=', thread).execute()
    // an automatic pause (no employee) is fine
    await t.db.updateTable('message_threads').set({ ai_paused_by: null }).where('id', '=', thread).execute()
  })
})

describe('every service has a category', () => {
  it('new rows get one by the default rule: add-ons, tint, detail (executive, exotic, ceramic, detail), else wash', async () => {
    const f = await setupLocation(t)
    const svc = async (kind: 'package' | 'addon', name: string, tags: string[]): Promise<string | null> => {
      const id = f.newId()
      await t.db
        .insertInto('services')
        .values({ id, location_id: f.locationId, kind, name, short_name: null, price_cents: 1000, duration_min: kind === 'addon' ? 0 : 60, tags, sqsp_sku: null })
        .execute()
      return (await t.db.selectFrom('services').select('category').where('id', '=', id).executeTakeFirstOrThrow()).category
    }
    expect(await svc('addon', 'Wax', ['ceramic'])).toBe('addons')
    expect(await svc('package', 'Executive Detail', ['executive'])).toBe('detail')
    expect(await svc('package', 'Executive Detail + Ceramic', ['executive', 'ceramic'])).toBe('detail')
    expect(await svc('package', 'Exotic Detail Package', ['exotic'])).toBe('detail')
    expect(await svc('package', 'Full Detail', ['detail'])).toBe('detail')
    expect(await svc('package', 'Express Hand Wash', ['express', 'handwash'])).toBe('wash')
    expect(await svc('package', 'Mystery', [])).toBe('wash')
    expect(await svc('package', 'Ceramic Tint', ['tint'])).toBe('tint')
    // an explicit category wins (the catalog API sets it)
    const id = f.newId()
    await t.db
      .insertInto('services')
      .values({ id, location_id: f.locationId, kind: 'package', name: 'Quote me', short_name: null, price_cents: 0, duration_min: 30, sqsp_sku: null, category: 'quote' })
      .execute()
    expect((await t.db.selectFrom('services').select('category').where('id', '=', id).executeTakeFirstOrThrow()).category).toBe('quote')
    expect(constraintOf(await failure(t.db.updateTable('services').set({ category: null as never }).where('id', '=', id).execute()))).toBeUndefined()
    expect(String(await failure(t.db.updateTable('services').set({ category: null as never }).where('id', '=', id).execute()))).toMatch(/null value in column "category"/)
  })

  it('a location without the default categories gets the one a new service needs', async () => {
    const loc = '00000000-0000-7000-8000-0000000000d1'
    await sql`insert into locations (id, name, slug) values (${loc}, 'Second', 'second')`.execute(t.db)
    await t.db
      .insertInto('services')
      .values({ id: '00000000-0000-7000-8000-0000000000d2', location_id: loc, kind: 'addon', name: 'Wax', short_name: null, price_cents: 1000, duration_min: 0, sqsp_sku: null })
      .execute()
    const cats = await t.db.selectFrom('catalog_categories').select(['key', 'label', 'colour', 'sort']).where('location_id', '=', loc).execute()
    expect(cats).toEqual([{ key: 'addons', label: 'Add-ons', colour: '#7FD6FF', sort: 20 }])
    // the trigger's copy of the defaults matches DEFAULT_CATEGORIES
    for (const [i, kind, tags] of [[3, 'package', []], [4, 'package', ['tint']], [5, 'package', ['detail']]] as const)
      await t.db
        .insertInto('services')
        .values({ id: `00000000-0000-7000-8000-0000000000d${i}`, location_id: loc, kind, name: `S${i}`, short_name: null, price_cents: 1000, duration_min: 30, tags: [...tags], sqsp_sku: null })
        .execute()
    const all = await t.db.selectFrom('catalog_categories').select(['key', 'label', 'colour', 'sort']).where('location_id', '=', loc).orderBy('sort').execute()
    expect(all).toEqual(DEFAULT_CATEGORIES.filter((c) => c.key !== 'quote').map(({ key, label, colour, sort }) => ({ key, label, colour, sort })))
  })
})
