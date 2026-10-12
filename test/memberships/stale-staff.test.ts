// Staff memberships on a stale record (ADR 0160, "W4c re-review 3 fixes" D3; the re-reviewer's staff join route): adding a
// membership by hand (POST /memberships) or setting one live (PATCH /memberships/:id) is a staff action, and a staff action is proof
// of the client (identity/stale.ts), so on a record the stale-record rule holds it would hand the old client's record to whoever
// holds the number now (a website join with that number asks staff to "add the membership on their record"). Both refuse with 409
// MEMBERSHIP_CLIENT_UNCONFIRMED until staff confirm the client (POST /customers/:id/identity/confirm, audited); then they work.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { staleRecord } from '../../src/modules/identity/stale.js'
import { useMemRig } from './harness.js'

const DAY = 86_400_000
const PHONE = '+12015550188'

describe('staff memberships on a stale record (W4c re-review 3, D3)', () => {
  const m = useMemRig()

  async function quietClient(days: number): Promise<string> {
    const db = m.h.t.db
    const id = m.h.t.app.newId()
    await db
      .insertInto('customers')
      .values({ id, full_name: 'Olga Quiet', phone_e164: PHONE, email: null, email_verified: false, sms_opted_in: true, source: 'import' })
      .execute()
    await sql`update customers set created_at = ${new Date(m.h.clock.now().getTime() - days * DAY)} where id = ${id}`.execute(db)
    return id
  }
  const stale = (id: string) => staleRecord(m.h.t.db, { locationId: m.locationId(), customerId: id, phone: PHONE, now: m.h.clock.now() })

  it('POST /memberships refuses on a stale record (nothing written, still stale) until staff confirm the client', async () => {
    const id = await quietClient(200)
    expect((await stale(id)).stale).toBe(true)
    const res = await m.send(m.superS(), 'POST', '/memberships', { customerId: id, planKey: 'gold', planLabel: 'Gold' })
    expect(res.statusCode, res.body).toBe(409)
    const body = res.json() as { code: string; detail: string }
    expect(body.code).toBe('MEMBERSHIP_CLIENT_UNCONFIRMED')
    expect(body.detail).toContain('quiet for 200 days')
    expect(body.detail).toContain('create a new client')
    expect(await m.h.t.db.selectFrom('memberships').select('id').where('customer_id', '=', id).execute()).toEqual([])
    expect((await stale(id)).stale).toBe(true)

    const ok = await m.send(m.superS(), 'POST', `/customers/${id}/identity/confirm`, {}, false)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(
      await m.h.t.db.selectFrom('audit_log').select('action').where('entity_id', '=', id).where('action', '=', 'identity.client.confirmed').execute(),
    ).toHaveLength(1)
    const created = await m.send(m.superS(), 'POST', '/memberships', { customerId: id, planKey: 'gold', planLabel: 'Gold' })
    expect(created.statusCode, created.body).toBe(201)
  })

  it('a client who is not stale gets the membership as before', async () => {
    const id = await quietClient(20)
    const res = await m.send(m.superS(), 'POST', '/memberships', { customerId: id, planKey: 'gold' })
    expect(res.statusCode, res.body).toBe(201)
  })

  it('PATCH /memberships/:id refuses to set a stale record’s membership live (a staff action is proof) but may cancel it', async () => {
    const id = await quietClient(400)
    const plan = await m.h.t.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()
    const mid = m.h.t.app.newId()
    const long = new Date(m.h.clock.now().getTime() - 300 * DAY)
    await m.h.t.db
      .insertInto('memberships')
      .values({ id: mid, location_id: m.locationId(), customer_id: id, plan_id: plan.id, plan_label: 'Gold', status: 'past_due', source: 'manual', started_at: long, created_at: long, updated_at: long })
      .execute()
    expect((await stale(id)).stale).toBe(true)
    const live = await m.send(m.superS(), 'PATCH', `/memberships/${mid}`, { status: 'active' })
    expect(live.statusCode, live.body).toBe(409)
    expect((live.json() as { code: string }).code).toBe('MEMBERSHIP_CLIENT_UNCONFIRMED')
    expect((await stale(id)).stale).toBe(true)
    const cancel = await m.send(m.superS(), 'PATCH', `/memberships/${mid}`, { status: 'canceled' })
    expect(cancel.statusCode, cancel.body).toBe(200)
    expect((await stale(id)).stale).toBe(true)
  })
})
