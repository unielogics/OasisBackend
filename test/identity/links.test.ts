// Personal links on Postgres (ADR 0160, design sections 5 and 10): the token exists only in what the caller texts (its SHA-256 is
// stored); the kind sets the lifetime and uses; a link is dead once expired, used up, revoked, superseded, or when the client's PIN,
// number or the links epoch changed, or the number opted out (even after START); the assistant's per-number limits.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { hashToken } from '../../src/modules/auth/tokens.js'
import { updateCustomer } from '../../src/modules/customers/service.js'
import { ASSISTANT_LINK_LIMITS, consumeLink, LINK_POLICY, linkUrl, resolveLink } from '../../src/modules/identity/links.js'
import { resolveSession } from '../../src/modules/identity/sessions.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
const MIN = 60_000

let invoiceNo = 0
/** An invoice of the client: one $50.00 item, no tax, nothing paid. */
async function invoice(customerId: string, cents = 5000): Promise<string> {
  const id = w.newId()
  await w.t.db
    .insertInto('invoices')
    .values({ id, location_id: w.locationId, invoice_no: ++invoiceNo, appointment_id: null, customer_id: customerId, client_name: 'Maria Delgado',
      occurred_at: w.clock.now(), biz_date: '2026-06-13', tax_bp: 0, tip_cents: 0 })
    .execute()
  await w.t.db.insertInto('invoice_items').values({ id: w.newId(), invoice_id: id, position: 0, kind: 'package', service_id: null, name: 'Express Hand Wash', price_cents: cents }).execute()
  return id
}
async function pay(invoiceId: string, customerId: string, cents: number): Promise<void> {
  await w.t.db
    .insertInto('ledger_events')
    .values({ id: w.newId(), location_id: w.locationId, invoice_id: invoiceId, customer_id: customerId, type: 'pay', amount_cents: cents, method: 'Cash', method_kind: 'cash', occurred_at: w.clock.now() })
    .execute()
}
const voidInvoice = (id: string) =>
  w.t.db.updateTable('invoices').set({ canceled_at: w.clock.now(), cancel_reason: 'canceled' }).where('id', '=', id).execute()

describe('issueClientLink', () => {
  it('stores only the SHA-256 of a 43-character token, and the URL carries it in the fragment', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'verify' })
    expect(l.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(l.url).toBe(`https://oasisautospanj.com/#/v/${l.token}`)
    expect(linkUrl('membership', 'x', 'https://site.example.test/')).toBe('https://site.example.test/#/m/x')
    const row = await w.t.db.selectFrom('client_links').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow()
    expect(row.token_hash).toBe(hashToken(l.token))
    // the token appears in no column of any row of the schema
    const dump = await sql<{ j: string }>`select string_agg(row_to_json(t)::text, '') as j from client_links t`.execute(w.t.db)
    expect(dump.rows[0]!.j).not.toContain(l.token)
    const audit = await sql<{ j: string | null }>`select string_agg(row_to_json(t)::text, '') as j from audit_log t`.execute(w.t.db)
    expect(audit.rows[0]!.j ?? '').not.toContain(l.token)
  })

  it('binds the number on file (a caller cannot pick another one), the versions and the epoch; lifetime and uses by kind', async () => {
    const maria = await w.customer({})
    const now = w.clock.now().getTime()
    for (const kind of ['verify', 'pin', 'calendar', 'book_again'] as const) {
      const l = await w.link({ customerId: maria, kind, phone: PHONES.other })
      expect(l.phone, kind).toBe(PHONES.maria)
      expect(l.expiresAt.getTime() - now, kind).toBe(LINK_POLICY[kind].ttlMs)
      expect(l.maxUses, kind).toBe(LINK_POLICY[kind].maxUses)
    }
    expect(LINK_POLICY.verify).toMatchObject({ ttlMs: 15 * MIN, maxUses: 1, maxExchanges: 5 })
    expect(LINK_POLICY.pin).toMatchObject({ ttlMs: 15 * MIN, maxUses: 1, maxExchanges: 5 })
    expect(LINK_POLICY.calendar).toMatchObject({ ttlMs: 72 * 60 * MIN, maxUses: 3 })
    expect(LINK_POLICY.book_again.ttlMs).toBe(14 * 24 * 60 * MIN)
    expect(LINK_POLICY.membership.ttlMs).toBe(24 * 60 * MIN)
    expect(LINK_POLICY.pay.ttlMs).toBe(7 * 24 * 60 * MIN)
    const row = await w.t.db.selectFrom('client_links').selectAll().where('kind', '=', 'verify').executeTakeFirstOrThrow()
    expect(row).toMatchObject({ pin_version: 0, phone_version: 0, epoch: 1, issued_by: 'staff' })
  })

  it('a shorter end is kept, a longer one is cut to the kind’s lifetime', async () => {
    const maria = await w.customer({})
    const soon = new Date(w.clock.now().getTime() + 5 * MIN)
    expect((await w.link({ customerId: maria, kind: 'calendar', expiresAt: soon })).expiresAt).toEqual(soon)
    const late = new Date(w.clock.now().getTime() + 30 * 24 * 60 * MIN)
    expect((await w.link({ customerId: maria, kind: 'verify', expiresAt: late })).expiresAt.getTime() - w.clock.now().getTime()).toBe(15 * MIN)
  })

  it('refuses a client without a number, a stranger’s PIN link, a foreign appointment and a pay link without an invoice', async () => {
    const nophone = await w.customer({ phone: null, name: 'No Phone' })
    await expect(w.link({ customerId: nophone, kind: 'verify' })).rejects.toMatchObject({ code: 'IDENTITY_NO_PHONE' })
    await expect(w.link({ customerId: null, kind: 'pin', phone: PHONES.stranger })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(w.link({ customerId: null, kind: 'calendar', phone: '+442071234567' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const maria = await w.customer({})
    await expect(w.link({ customerId: maria, kind: 'pay' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(w.link({ customerId: maria, kind: 'calendar', appointmentId: w.newId() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const stranger = await w.link({ customerId: null, kind: 'calendar', phone: '(201) 555-0113' })
    expect(stranger.phone).toBe(PHONES.stranger)
  })

  it('a pay link names an open invoice: a void or an already paid one is refused', async () => {
    const maria = await w.customer({})
    const paid = await invoice(maria)
    await pay(paid, maria, 5000)
    await expect(w.link({ customerId: maria, kind: 'pay', invoiceId: paid })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const voided = await invoice(maria)
    await voidInvoice(voided)
    await expect(w.link({ customerId: maria, kind: 'pay', invoiceId: voided })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const open = await invoice(maria)
    await pay(open, maria, 2000)
    expect((await w.link({ customerId: maria, kind: 'pay', invoiceId: open })).kind).toBe('pay')
  })

  it('supersedes the live link of the same kind to the same number', async () => {
    const maria = await w.customer({})
    const a = await w.link({ customerId: maria, kind: 'verify' })
    const b = await w.link({ customerId: maria, kind: 'verify' })
    const c = await w.link({ customerId: maria, kind: 'calendar' })
    expect(await resolveLink(w.t.db, a.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    expect((await resolveLink(w.t.db, b.token, w.clock.now())).ok).toBe(true)
    expect((await resolveLink(w.t.db, c.token, w.clock.now())).ok).toBe(true)
    expect((await w.t.db.selectFrom('client_links').select('revoke_reason').where('id', '=', a.id).executeTakeFirstOrThrow()).revoke_reason).toBe('superseded')
  })

  it('the assistant gets at most one link of a kind an hour and three a day per number; staff and system links are not counted', async () => {
    const maria = await w.customer({})
    expect(ASSISTANT_LINK_LIMITS).toEqual({ perDay: 3, perKindPerHour: 1 })
    await w.link({ customerId: maria, kind: 'verify', issuedBy: 'assistant' })
    await expect(w.link({ customerId: maria, kind: 'verify', issuedBy: 'assistant' })).rejects.toMatchObject({ code: 'IDENTITY_LINK_LIMIT' })
    await w.link({ customerId: maria, kind: 'verify', issuedBy: 'staff' })
    await w.link({ customerId: maria, kind: 'calendar', issuedBy: 'assistant' })
    w.advance(61 * MIN)
    await w.link({ customerId: maria, kind: 'verify', issuedBy: 'assistant' })
    await expect(w.link({ customerId: maria, kind: 'pin', issuedBy: 'assistant' })).rejects.toMatchObject({ code: 'IDENTITY_LINK_LIMIT' })
    w.advance(24 * 60 * MIN)
    await w.link({ customerId: maria, kind: 'pin', issuedBy: 'assistant' })
  })
})

describe('resolveLink and consumeLink', () => {
  it('opening uses nothing; a completion uses one, and a used-up link cannot be opened or completed again', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'calendar' })
    for (let i = 0; i < 5; i++) expect((await resolveLink(w.t.db, l.token, w.clock.now())).ok).toBe(true)
    for (let i = 1; i <= 3; i++) expect((await w.tx((tx) => consumeLink(tx, l.id, w.clock.now()))).uses).toBe(i)
    await expect(w.tx((tx) => consumeLink(tx, l.id, w.clock.now()))).rejects.toMatchObject({ code: 'IDENTITY_LINK_USED' })
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'used' })
  })

  it('an expired link and a malformed or unknown token are dead (the malformed one never reaches the database)', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'verify' })
    w.advance(15 * MIN)
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'expired' })
    expect(await resolveLink(w.t.db, 'short', w.clock.now())).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolveLink(w.t.db, 'A'.repeat(43), w.clock.now())).toEqual({ ok: false, reason: 'not_found' })
  })

  it('an epoch bump kills every link', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'calendar' })
    const s = await w.link({ customerId: null, kind: 'calendar', phone: PHONES.stranger })
    await w.bumpEpoch()
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    expect(await resolveLink(w.t.db, s.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    // a link issued in the new epoch works
    expect((await resolveLink(w.t.db, (await w.link({ customerId: maria, kind: 'pin' })).token, w.clock.now())).ok).toBe(true)
  })

  it('a phone change (updateCustomer) kills the links even if the number later comes back, and revokes them', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'calendar' })
    await w.tx((tx) => updateCustomer(tx, { id: maria, patch: { phone: PHONES.other } }))
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    const row = await w.t.db.selectFrom('client_links').select(['revoke_reason']).where('id', '=', l.id).executeTakeFirstOrThrow()
    expect(row.revoke_reason).toBe('phone_change')
    // same number back: the phone version moved on twice, the old link stays dead
    await w.t.db.updateTable('client_links').set({ revoked_at: null, revoke_reason: null }).where('id', '=', l.id).execute()
    await w.tx((tx) => updateCustomer(tx, { id: maria, patch: { phone: PHONES.maria } }))
    expect((await w.t.db.selectFrom('customers').select('phone_version').where('id', '=', maria).executeTakeFirstOrThrow()).phone_version).toBe(2)
    await w.t.db.updateTable('client_links').set({ revoked_at: null, revoke_reason: null }).where('id', '=', l.id).execute()
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    // editing anything else does not touch the links
    const k = await w.link({ customerId: maria, kind: 'calendar' })
    await w.tx((tx) => updateCustomer(tx, { id: maria, patch: { fullName: 'Maria D. Delgado', phone: '(201) 555-0111' } }))
    expect((await resolveLink(w.t.db, k.token, w.clock.now())).ok).toBe(true)
  })

  it('a PIN set, reset or clear kills the links issued before it (version binding)', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'calendar' })
    await w.t.db.insertInto('customer_pins').values({ customer_id: maria, pin_hash: '$scrypt$x'.padEnd(30, 'x'), version: 1, set_at: w.clock.now() }).execute()
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    const after = await w.link({ customerId: maria, kind: 'calendar' })
    expect((await w.t.db.selectFrom('client_links').select('pin_version').where('id', '=', after.id).executeTakeFirstOrThrow()).pin_version).toBe(1)
    expect((await resolveLink(w.t.db, after.token, w.clock.now())).ok).toBe(true)
  })

  it('a STOP after the link was issued kills it, and START does not revive it', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'calendar' })
    const stranger = await w.link({ customerId: null, kind: 'calendar', phone: PHONES.stranger })
    w.advance(MIN)
    for (const phone of [PHONES.maria, PHONES.stranger])
      await w.t.db
        .insertInto('sms_opt_outs')
        .values({ id: w.newId(), location_id: w.locationId, phone_e164: phone, opted_out_at: w.clock.now(), source: 'keyword', keyword: 'STOP', opted_in_again_at: w.clock.now() })
        .execute()
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    expect(await resolveLink(w.t.db, stranger.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    // a link issued after the START works
    w.advance(MIN)
    expect((await resolveLink(w.t.db, (await w.link({ customerId: maria, kind: 'pin' })).token, w.clock.now())).ok).toBe(true)
  })

  it('a merged or deleted client’s links are dead', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'calendar' })
    await w.t.db.updateTable('customers').set({ deleted_at: w.clock.now() }).where('id', '=', maria).execute()
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
  })

  it('a pay link dies once its invoice is paid or voided after issue (design section 5: "pay until paid/void"), sessions with it', async () => {
    const maria = await w.customer({})
    const inv = await invoice(maria)
    const l = await w.link({ customerId: maria, kind: 'pay', invoiceId: inv })
    const s = await w.session({ customerId: maria, kind: 'pay', invoiceId: inv })
    expect((await resolveLink(w.t.db, s.link.token, w.clock.now())).ok).toBe(true)
    // the first link was superseded by the second one, to the same invoice
    expect(await resolveLink(w.t.db, l.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    await pay(inv, maria, 4999)
    expect((await resolveLink(w.t.db, s.link.token, w.clock.now())).ok).toBe(true)
    await pay(inv, maria, 1)
    expect(await resolveLink(w.t.db, s.link.token, w.clock.now())).toEqual({ ok: false, reason: 'used' })
    await expect(w.tx((tx) => consumeLink(tx, s.link.id, w.clock.now()))).rejects.toMatchObject({ code: 'IDENTITY_LINK_USED' })
    await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })

    const other = await invoice(maria)
    const v = await w.session({ customerId: maria, kind: 'pay', invoiceId: other })
    await voidInvoice(other)
    expect(await resolveLink(w.t.db, v.link.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    await expect(w.tx((tx) => consumeLink(tx, v.link.id, w.clock.now()))).rejects.toMatchObject({ code: 'IDENTITY_LINK_INVALID' })
    await expect(resolveSession(w.t.db, v.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
  })
})
