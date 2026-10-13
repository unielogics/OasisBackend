// Attribution in every command path (ADR 0180, wave K1b), generated from the kiosk route list: every `actor` route called by an
// unlocked kiosk with Marco tapped writes its audit row with actor_employee_id = Marco, the kiosk device and no user, exactly one
// staff_events row of the expected kind (Marco, the device, via kiosk, no user), and activity lines that say "Marco R." with his
// employee id and the device. A new `actor` route fails here until it has a scenario. Then the worker rule (kiosk only), the Staff view
// with a worker who is not crew, the ledger's actor, refunds and voids refused, the text's sender, and the history backfill.
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/config/env.js'
import { createStorageProvider } from '../../src/integrations/storage/config.js'
import { backfillStaffEvents } from '../../src/modules/kiosk/backfill.js'
import { KIOSK_ROUTES } from '../../src/modules/kiosk/allowlist.js'
import type { StaffEventKind } from '../../src/modules/kiosk/schema.js'
import { saveCardOnFile } from '../../src/modules/square/cards.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { kioskWorld as makeWorld, type KioskWorld } from './world.js'
import { idemKey, invoiceState, useRig } from '../scheduling-gaps/support.js'
import { silent, squareEnvFor } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const m = useRig()
afterEach(() => configureSquareRuntime({}))

const A = '/api/v1'
const TODAY = (hhmm: string) => `2026-06-13T${hhmm}:00-04:00`

type World = KioskWorld

interface Call {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  body?: unknown
}

interface Scenario {
  /** The staff event the call records (exactly one of this kind); null: none (only a presigned upload slot). */
  kind: StaffEventKind | null
  /** The audit action written with Marco as the actor; null: the call audits nothing. */
  audit: string | null
  /** The call writes activity lines in Marco's name. */
  activity: boolean
  prepare(w: World): Promise<Call>
}

// --- fixtures ---------------------------------------------------------------------------------------------------------------

const db = () => m.h.t.db
const sup = () => m.superS()

async function serviceId(name: string, kind: 'package' | 'addon' = 'package'): Promise<string> {
  return (await db().selectFrom('services').select('id').where('name', '=', name).where('kind', '=', kind).executeTakeFirstOrThrow()).id
}
async function anyAddon(): Promise<string> {
  return (await db().selectFrom('services').select('id').where('kind', '=', 'addon').where('active', '=', true).orderBy('name').executeTakeFirstOrThrow()).id
}
async function bay(n: number): Promise<string> {
  return (await db().selectFrom('bays').select('id').where('number', '=', n).executeTakeFirstOrThrow()).id
}

/** Later today, a different hour each time, so a test's visits never fill the two bays of one slot. */
const SLOTS = ['11:00', '12:00', '13:00', '14:00', '15:00', '16:00']
let slot = 0

/** A visit of Maria's later today, moved by the Super Admin (signed in) to `status`. */
async function visit(status: 'booked' | 'confirmed' | 'arrived' | 'cleaning' | 'completed' = 'booked', customer = 'Maria Delgado') {
  const v = await m.book(customer, 'Express Hand Wash', TODAY(SLOTS[slot++ % SLOTS.length]!))
  const steps = ['booked', 'confirmed', 'arrived', 'cleaning', 'completed'] as const
  for (const from of steps.slice(0, steps.indexOf(status))) {
    const r =
      from === 'arrived'
        ? await m.send(sup(), 'POST', `/appointments/${v.appointmentId}/assign-bay`, { bayId: await bay(1) }, false)
        : await m.send(sup(), 'POST', `/appointments/${v.appointmentId}/advance`, { expectedStatus: from }, false)
    if (r.statusCode !== 200) throw new Error(`moving to ${status}: ${r.statusCode} ${r.body}`)
  }
  return v
}

async function checklistItems(appointmentId: string): Promise<string[]> {
  return (
    await db()
      .selectFrom('job_checklist_items')
      .select('id')
      .where('appointment_id', '=', appointmentId)
      .where('removed_at', 'is', null)
      .orderBy('position')
      .execute()
  ).map((r) => r.id)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** The Square runtime pointed at a simulator with Square the processor and writes on (the saved-card tender). */
function squareOn(): { env: Env; sim: ReturnType<typeof simFor> } {
  const sim = simFor(m.h.clock)
  const env = squareEnvFor({})
  configureSquareRuntime({ env, api: () => sim.api })
  return { env, sim }
}

// --- one scenario per `actor` route --------------------------------------------------------------------------------------------

const SCENARIOS: Record<string, Scenario> = {
  [`POST ${A}/appointments`]: {
    kind: 'walk_in',
    audit: 'appointment.create',
    activity: true,
    prepare: async () => ({
      method: 'POST',
      url: 'appointments',
      body: { customer: { id: await m.customer('Priya Nair') }, serviceId: await serviceId('Express Hand Wash'), walkIn: true, source: 'walk_in' },
    }),
  },
  [`POST ${A}/customers`]: {
    kind: 'customer_create',
    audit: 'customer.create',
    activity: false,
    prepare: async () => ({ method: 'POST', url: 'customers', body: { name: 'Walk In', phone: '(201) 555-0142' } }),
  },
  [`PATCH ${A}/appointments/:id`]: {
    kind: 'update',
    audit: 'appointment.update',
    activity: true,
    prepare: async () => ({ method: 'PATCH', url: `appointments/${(await visit()).appointmentId}`, body: { notes: 'Scratch on the rear door' } }),
  },
  [`PUT ${A}/appointments/:id/vehicle-class`]: {
    kind: 'size_change',
    audit: 'appointment.vehicle_class.set',
    activity: true,
    prepare: async () => {
      const v = await visit()
      const a = await db().selectFrom('appointments').select(['version', 'vehicle_class']).where('id', '=', v.appointmentId).executeTakeFirstOrThrow()
      const other = await db()
        .selectFrom('vehicle_classes')
        .select('key')
        .where('location_id', '=', m.locationId())
        .where('key', '<>', a.vehicle_class ?? '')
        .where('active', '=', true)
        .orderBy('sort')
        .executeTakeFirstOrThrow()
      return { method: 'PUT', url: `appointments/${v.appointmentId}/vehicle-class`, body: { vehicleClass: other.key, version: a.version } }
    },
  },
  [`POST ${A}/appointments/:id/confirm`]: {
    kind: 'confirm',
    audit: 'appointment.confirm',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit()).appointmentId}/confirm`, body: {} }),
  },
  [`POST ${A}/appointments/:id/arrive`]: {
    kind: 'arrive',
    audit: 'appointment.arrive',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit('confirmed')).appointmentId}/arrive`, body: {} }),
  },
  [`POST ${A}/appointments/:id/start`]: {
    kind: 'start',
    audit: 'appointment.start',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit('arrived')).appointmentId}/start`, body: {} }),
  },
  [`POST ${A}/appointments/:id/assign-bay`]: {
    kind: 'assign_bay',
    audit: 'appointment.assign_bay',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit()).appointmentId}/assign-bay`, body: { bayId: await bay(2) } }),
  },
  [`POST ${A}/appointments/:id/complete`]: {
    kind: 'complete',
    audit: 'appointment.complete',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit('cleaning')).appointmentId}/complete`, body: {} }),
  },
  [`POST ${A}/appointments/:id/advance`]: {
    kind: 'start',
    audit: 'appointment.start',
    activity: true,
    prepare: async () => ({
      method: 'POST',
      url: `appointments/${(await visit('arrived')).appointmentId}/advance`,
      body: { expectedStatus: 'arrived' },
    }),
  },
  [`POST ${A}/appointments/:id/prep-bay`]: {
    kind: 'prep_bay',
    audit: 'appointment.prep_bay',
    activity: true,
    prepare: async () => {
      const v = await visit()
      await m.send(sup(), 'PATCH', `/appointments/${v.appointmentId}`, { plannedBayId: await bay(2) }, false)
      return { method: 'POST', url: `appointments/${v.appointmentId}/prep-bay`, body: {} }
    },
  },
  [`POST ${A}/appointments/:id/pickup`]: {
    kind: 'pickup',
    audit: 'appointment.pickup',
    activity: true,
    prepare: async () => ({
      method: 'POST',
      url: `appointments/${(await visit('completed')).appointmentId}/pickup`,
      body: { state: 'collected' },
    }),
  },
  [`POST ${A}/appointments/:id/notify-ready`]: {
    kind: 'notify_ready',
    audit: 'appointment.notify_ready',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit('completed')).appointmentId}/notify-ready`, body: {} }),
  },
  [`POST ${A}/appointments/:id/reschedule`]: {
    kind: 'reschedule',
    audit: 'appointment.reschedule',
    activity: true,
    prepare: async () => ({
      method: 'POST',
      url: `appointments/${(await visit()).appointmentId}/reschedule`,
      body: { start: '2026-06-15T10:00:00-04:00' },
    }),
  },
  [`POST ${A}/appointments/:id/arrival-link`]: {
    kind: 'arrival_link',
    audit: 'appointment.arrival_link',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit()).appointmentId}/arrival-link`, body: {} }),
  },
  [`POST ${A}/appointments/:id/messages`]: {
    kind: 'text',
    audit: 'message.staff_send',
    activity: true,
    prepare: async () => ({
      method: 'POST',
      url: `appointments/${(await visit()).appointmentId}/messages`,
      body: { text: 'Your car is next in line.' },
    }),
  },
  [`PUT ${A}/appointments/:id/addons/:serviceId`]: {
    kind: 'addon_add',
    audit: 'appointment.addon.add',
    activity: true,
    prepare: async () => ({ method: 'PUT', url: `appointments/${(await visit()).appointmentId}/addons/${await anyAddon()}`, body: {} }),
  },
  [`DELETE ${A}/appointments/:id/addons/:serviceId`]: {
    kind: 'addon_remove',
    audit: 'appointment.addon.remove',
    activity: true,
    prepare: async () => {
      const v = await visit()
      const addon = await anyAddon()
      const r = await m.send(sup(), 'PUT', `/appointments/${v.appointmentId}/addons/${addon}`, {}, false)
      if (r.statusCode !== 200) throw new Error(`add-on: ${r.statusCode} ${r.body}`)
      return { method: 'DELETE', url: `appointments/${v.appointmentId}/addons/${addon}` }
    },
  },
  [`PUT ${A}/appointments/:id/checklist/items/:itemId`]: {
    kind: 'checklist',
    audit: 'appointment.checklist.item',
    activity: false,
    prepare: async () => {
      const v = await visit('cleaning')
      const [item] = await checklistItems(v.appointmentId)
      return { method: 'PUT', url: `appointments/${v.appointmentId}/checklist/items/${item}`, body: { done: true } }
    },
  },
  [`POST ${A}/appointments/:id/checklist/bulk`]: {
    kind: 'checklist',
    audit: 'appointment.checklist.bulk',
    activity: true,
    prepare: async () => {
      const v = await visit('cleaning')
      return { method: 'POST', url: `appointments/${v.appointmentId}/checklist/bulk`, body: { itemIds: await checklistItems(v.appointmentId), done: true } }
    },
  },
  [`POST ${A}/appointments/:id/photos/presign`]: {
    kind: null,
    audit: null,
    activity: false,
    prepare: async () => ({
      method: 'POST',
      url: `appointments/${(await visit('cleaning')).appointmentId}/photos/presign`,
      body: { category: 'before', contentType: 'image/png', bytes: PNG.length },
    }),
  },
  [`POST ${A}/appointments/:id/photos/:photoId/complete`]: {
    kind: 'photo',
    audit: 'appointment.photo.add',
    activity: true,
    prepare: async () => {
      const v = await visit('cleaning')
      const p = await m.send(sup(), 'POST', `/appointments/${v.appointmentId}/photos/presign`, { category: 'after', contentType: 'image/png', bytes: PNG.length }, false)
      if (p.statusCode !== 201) throw new Error(`presign: ${p.statusCode} ${p.body}`)
      const slot = p.json() as { photoId: string; upload: { key: string } }
      await createStorageProvider(m.h.t.env, { clock: m.h.clock }).put(slot.upload.key, PNG, 'image/png')
      return { method: 'POST', url: `appointments/${v.appointmentId}/photos/${slot.photoId}/complete`, body: {} }
    },
  },
  [`POST ${A}/appointments/:id/photos/note`]: {
    kind: 'photo',
    audit: 'appointment.photo.note',
    activity: true,
    prepare: async () => ({ method: 'POST', url: `appointments/${(await visit('cleaning')).appointmentId}/photos/note`, body: { note: 'Chip in the windshield' } }),
  },
  [`POST ${A}/invoices/:id/payments`]: {
    kind: 'payment',
    audit: 'payments.collect',
    activity: false,
    prepare: async () => ({ method: 'POST', url: `invoices/${(await visit('completed')).invoiceId}/payments`, body: { method: 'cash' } }),
  },
  [`POST ${A}/invoices/:id/credit-applications`]: {
    kind: 'payment',
    audit: 'payments.credit_apply',
    activity: false,
    prepare: async () => {
      const v = await visit('completed')
      const c = await m.send(sup(), 'POST', `/invoices/${v.invoiceId}/credits`, { amountCents: 1000, reason: 'Goodwill', expiry: 'none' })
      if (c.statusCode !== 201) throw new Error(`credit: ${c.statusCode} ${c.body}`)
      return { method: 'POST', url: `invoices/${v.invoiceId}/credit-applications`, body: {} }
    },
  },
  [`POST ${A}/invoices/:id/receipt`]: {
    kind: 'receipt',
    audit: 'payments.receipt',
    activity: false,
    prepare: async () => ({ method: 'POST', url: `invoices/${(await visit('completed')).invoiceId}/receipt`, body: {} }),
  },
  [`POST ${A}/invoices/:id/payment-links`]: {
    kind: 'payment_link',
    audit: 'payments.payment_link',
    activity: false,
    prepare: async () => ({
      method: 'POST',
      url: `invoices/${(await visit('completed')).invoiceId}/payment-links`,
      body: { kind: 'balance', url: 'https://oasis-auto-spa.squarespace.com/checkout/pay-123' },
    }),
  },
  [`POST ${A}/invoices/:id/card-charges`]: {
    kind: 'payment',
    audit: 'card.charged',
    activity: false,
    prepare: async () => {
      const { env, sim } = squareOn()
      const v = await visit('completed')
      const card = await saveCardOnFile(
        { db: db(), clock: m.h.clock, newId: m.h.t.app.newId, env, api: sim.api, locationId: m.locationId(), logger: silent },
        {
          customerId: await m.customer('Maria Delgado'),
          sourceId: 'cnon:card-nonce-ok',
          purposes: ['balance'],
          consentVersion: 'v1',
          ip: '203.0.113.9',
          userAgent: 'test',
          keyBase: `kiosk-attr-${v.invoiceId}`,
          postalCode: '07026',
        },
      )
      const balance = (await invoiceState(m, v.invoiceId)).balance
      return { method: 'POST', url: `invoices/${v.invoiceId}/card-charges`, body: { cardId: card.cardId, amountCents: balance } }
    },
  },
  [`PUT ${A}/invoices/:id/tip`]: {
    kind: 'tip',
    audit: 'payments.tip',
    activity: false,
    prepare: async () => ({ method: 'PUT', url: `invoices/${(await visit('completed')).invoiceId}/tip`, body: { tipCents: 500 } }),
  },
}

const ACTOR_ROUTES = Object.entries(KIOSK_ROUTES)
  .filter(([, mode]) => mode === 'actor')
  .map(([key]) => key)

const maxId = async (table: 'audit_log' | 'activity_log' | 'staff_events'): Promise<number> =>
  Number((await db().selectFrom(table).select((eb) => eb.fn.max('id').as('id')).executeTakeFirst())?.id ?? 0)

const kioskWorld = (): Promise<World> => makeWorld(m.h)

const kioskSend = (w: World, c: Call, actor = w.marco.employeeId) =>
  m.h.kioskCall(c.method, `${A}/${c.url}`, w.kiosk, { actor, body: c.body ?? (c.method === 'DELETE' ? undefined : {}), headers: { 'idempotency-key': idemKey() } })

describe('attribution in every command path (generated from the kiosk route list)', () => {
  it('every actor route has a scenario, and every scenario is an actor route', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ACTOR_ROUTES].sort())
  })

  for (const key of ACTOR_ROUTES) {
    it(`${key}: audit, one staff event and activity in Marco's name, with the device and no user`, async () => {
      const s = SCENARIOS[key]
      expect(s, `no scenario for ${key}`).toBeDefined()
      const w = await kioskWorld()
      const call = await s!.prepare(w)
      const [audit0, activity0, events0] = await Promise.all([maxId('audit_log'), maxId('activity_log'), maxId('staff_events')])
      const res = await kioskSend(w, call)
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(200)
      expect(res.statusCode, res.body).toBeLessThan(300)

      const audits = await db().selectFrom('audit_log').selectAll().where('id', '>', audit0).orderBy('id').execute()
      // nobody's user id is written by a kiosk request
      expect(audits.filter((a) => a.actor_user_id !== null)).toEqual([])
      if (s!.audit) {
        const mine = audits.filter((a) => a.action === s!.audit)
        expect(mine.length, `${s!.audit} in ${audits.map((a) => a.action).join(', ')}`).toBeGreaterThanOrEqual(1)
        for (const a of mine)
          expect(a).toMatchObject({ actor_user_id: null, actor_employee_id: w.marco.employeeId, actor_name: 'Marco R.', kiosk_device_id: w.device.id })
      }

      const events = await db().selectFrom('staff_events').selectAll().where('id', '>', events0).orderBy('id').execute()
      const ofKind = events.filter((e) => e.kind === s!.kind)
      if (s!.kind === null) expect(events).toEqual([])
      else {
        expect(ofKind, `events: ${events.map((e) => e.kind).join(', ')}`).toHaveLength(1)
        expect(ofKind[0]).toMatchObject({
          employee_id: w.marco.employeeId,
          employee_name: 'Marco R.',
          via: 'kiosk',
          kiosk_device_id: w.device.id,
          user_id: null,
          location_id: m.locationId(),
        })
        if (s!.audit) expect(ofKind[0]!.audit_id).toBe(audits.find((a) => a.action === s!.audit)!.id)
      }
      for (const e of events) expect(e).toMatchObject({ employee_id: w.marco.employeeId, via: 'kiosk', kiosk_device_id: w.device.id, user_id: null })

      const lines = await db().selectFrom('activity_log').selectAll().where('id', '>', activity0).where('actor_type', '=', 'staff').execute()
      if (s!.activity) expect(lines.length).toBeGreaterThanOrEqual(1)
      for (const l of lines)
        expect(l).toMatchObject({ actor_name: 'Marco R.', actor_employee_id: w.marco.employeeId, kiosk_device_id: w.device.id })
    }, 60_000)
  }

  it('the presigned upload slot names Marco, not a user', async () => {
    const w = await kioskWorld()
    const res = await kioskSend(w, await SCENARIOS[`POST ${A}/appointments/:id/photos/presign`]!.prepare(w))
    expect(res.statusCode, res.body).toBe(201)
    const row = await db().selectFrom('appointment_photos').selectAll().where('id', '=', (res.json() as Json).photoId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ uploaded_by: null, uploaded_by_employee_id: w.marco.employeeId })
  })

  it('the booking, the add-on and the payment link record Marco in their own employee columns', async () => {
    const w = await kioskWorld()
    const booked = await kioskSend(w, await SCENARIOS[`POST ${A}/appointments`]!.prepare(w))
    expect(booked.statusCode, booked.body).toBe(201)
    const id = (booked.json() as Json).appointment.id as string
    expect(await db().selectFrom('appointments').select(['created_by', 'created_by_employee_id']).where('id', '=', id).executeTakeFirstOrThrow()).toEqual({
      created_by: null,
      created_by_employee_id: w.marco.employeeId,
    })
    const addon = await anyAddon()
    expect((await kioskSend(w, { method: 'PUT', url: `appointments/${id}/addons/${addon}`, body: {} })).statusCode).toBe(200)
    expect(
      await db().selectFrom('appointment_addons').select(['added_by', 'added_by_employee_id']).where('appointment_id', '=', id).where('service_id', '=', addon).executeTakeFirstOrThrow(),
    ).toEqual({ added_by: null, added_by_employee_id: w.marco.employeeId })
    const link = await kioskSend(w, await SCENARIOS[`POST ${A}/invoices/:id/payment-links`]!.prepare(w))
    expect(link.statusCode, link.body).toBe(201)
    const row = await db().selectFrom('payment_links').select(['created_by', 'created_by_employee_id']).orderBy('created_at', 'desc').executeTakeFirstOrThrow()
    expect(row).toEqual({ created_by: null, created_by_employee_id: w.marco.employeeId })
  })
})

describe('the worker rule: the kiosk employee who puts a car in a bay is its worker', () => {
  const workerOf = async (id: string) =>
    (await db().selectFrom('appointments').select('assigned_employee_id').where('id', '=', id).executeTakeFirstOrThrow()).assigned_employee_id

  for (const how of ['assign-bay', 'start', 'advance'] as const) {
    it(`${how} on the kiosk sets Marco as the worker, with "Worker: Marco R." and a worker_set event`, async () => {
      const w = await kioskWorld()
      const v = await visit(how === 'assign-bay' ? 'confirmed' : 'arrived')
      const body = how === 'assign-bay' ? { bayId: await bay(2) } : how === 'advance' ? { expectedStatus: 'arrived' } : {}
      const res = await kioskSend(w, { method: 'POST', url: `appointments/${v.appointmentId}/${how}`, body })
      expect(res.statusCode, res.body).toBe(200)
      expect(await workerOf(v.appointmentId)).toBe(w.marco.employeeId)
      expect((res.json() as Json).appointment.assignedEmployeeId).toBe(w.marco.employeeId)
      const lines = await db().selectFrom('activity_log').select(['text', 'actor_employee_id']).where('appointment_id', '=', v.appointmentId).orderBy('id').execute()
      expect(lines).toContainEqual({ text: 'Worker: Marco R.', actor_employee_id: w.marco.employeeId })
      const kinds = (await db().selectFrom('staff_events').select('kind').where('appointment_id', '=', v.appointmentId).orderBy('id').execute()).map((e) => e.kind)
      expect(kinds).toContain('worker_set')
      // the audit row says who the worker became
      const a = await db().selectFrom('audit_log').select('after').where('entity_id', '=', v.appointmentId).where('action', 'in', ['appointment.assign_bay', 'appointment.start']).executeTakeFirstOrThrow()
      expect(a.after).toMatchObject({ assignedEmployeeId: w.marco.employeeId })
    })
  }

  it('the same worker again: no second "Worker" line and no worker_set event', async () => {
    const w = await kioskWorld()
    const v = await visit('arrived')
    await m.send(sup(), 'PATCH', `/appointments/${v.appointmentId}`, { assignedEmployeeId: w.marco.employeeId }, false)
    const res = await kioskSend(w, { method: 'POST', url: `appointments/${v.appointmentId}/start`, body: {} })
    expect(res.statusCode, res.body).toBe(200)
    const texts = (await db().selectFrom('activity_log').select('text').where('appointment_id', '=', v.appointmentId).execute()).map((x) => x.text)
    expect(texts.filter((t) => t.startsWith('Worker:'))).toEqual([])
    expect(await db().selectFrom('staff_events').select('id').where('kind', '=', 'worker_set').execute()).toEqual([])
  })

  it('a signed-in person putting a car in a bay leaves the worker as it was', async () => {
    const w = await kioskWorld()
    const v = await visit('arrived')
    await m.send(sup(), 'PATCH', `/appointments/${v.appointmentId}`, { assignedEmployeeId: w.marco.employeeId }, false)
    const res = await m.send(sup(), 'POST', `/appointments/${v.appointmentId}/start`, {}, false)
    expect(res.statusCode, res.body).toBe(200)
    expect(await workerOf(v.appointmentId)).toBe(w.marco.employeeId)
    const v2 = await visit('confirmed', 'David Okafor')
    expect((await m.send(sup(), 'POST', `/appointments/${v2.appointmentId}/assign-bay`, { bayId: await bay(2) }, false)).statusCode).toBe(200)
    expect(await workerOf(v2.appointmentId)).toBeNull()
    expect(await db().selectFrom('staff_events').select('id').where('kind', '=', 'worker_set').execute()).toEqual([])
  })

  it('an invited employee can be assigned as the worker; an inactive one or one of another shop cannot', async () => {
    const v = await visit()
    const id = m.h.t.app.newId()
    await db().insertInto('employees').values({ id, first: 'Nina', last: 'Park', status: 'invited' }).execute()
    await db().insertInto('employee_locations').values({ employee_id: id, location_id: m.locationId() }).execute()
    const ok = await m.send(sup(), 'PATCH', `/appointments/${v.appointmentId}`, { assignedEmployeeId: id }, false)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await workerOf(v.appointmentId)).toBe(id)
    const gone = m.h.t.app.newId()
    await db().insertInto('employees').values({ id: gone, first: 'Old', last: 'Hand', status: 'inactive', deactivated_at: new Date('2026-06-01T12:00:00Z') }).execute()
    await db().insertInto('employee_locations').values({ employee_id: gone, location_id: m.locationId() }).execute()
    const elsewhere = m.h.t.app.newId()
    await db().insertInto('employees').values({ id: elsewhere, first: 'Far', last: 'Away', status: 'active' }).execute()
    for (const bad of [gone, elsewhere]) {
      const r = await m.send(sup(), 'PATCH', `/appointments/${v.appointmentId}`, { assignedEmployeeId: bad }, false)
      expect(r.statusCode).toBe(422)
      expect((r.json() as Json).errors[0]).toMatchObject({ path: 'assignedEmployeeId' })
    }
  })
})

describe('the Staff view shows a worker who is not crew', () => {
  it('a car placed by the front desk on the kiosk sits in that person’s column, never in none', async () => {
    const w = await kioskWorld()
    const desk = await m.h.createUser({ email: 'desk@example.test', first: 'Dana', last: 'Lopez', roles: ['support'] })
    const v = await visit('confirmed')
    const res = await kioskSend(w, { method: 'POST', url: `appointments/${v.appointmentId}/assign-bay`, body: { bayId: await bay(2) } }, desk.employeeId)
    expect(res.statusCode, res.body).toBe(200)
    const snap = (await m.get(sup(), '/ops/snapshot?window=today')).json() as Json
    const columns = snap.staff as { employeeId: string | null; name: string; jobs: { id: string }[] }[]
    const holding = columns.filter((c) => c.jobs.some((j) => j.id === v.appointmentId))
    expect(holding.map((c) => c.employeeId)).toEqual([desk.employeeId])
    expect(holding[0]!.name).toBe('Dana L.')
    // the crew columns come first, the Unassigned queue last
    expect(columns[columns.length - 1]!.employeeId).toBeNull()
  })
})

describe('money and texts on the kiosk', () => {
  it('the ledger names Marco (no user, roles Kiosk); refunds and voids are not on the kiosk', async () => {
    const w = await kioskWorld()
    const v = await visit('completed')
    const pay = await kioskSend(w, { method: 'POST', url: `invoices/${v.invoiceId}/payments`, body: { method: 'cash' } })
    expect(pay.statusCode, pay.body).toBe(201)
    const ev = await db().selectFrom('ledger_events').selectAll().where('invoice_id', '=', v.invoiceId).where('type', '=', 'pay').executeTakeFirstOrThrow()
    expect(ev).toMatchObject({ actor_user_id: null, actor_employee_id: w.marco.employeeId, actor_name: 'Marco R.' })
    const staff = await db().selectFrom('staff_events').selectAll().where('kind', '=', 'payment').executeTakeFirstOrThrow()
    expect(staff).toMatchObject({ ledger_event_id: ev.id, amount_cents: ev.amount_cents, appointment_id: v.appointmentId })
    const refund = await kioskSend(w, { method: 'POST', url: `invoices/${v.invoiceId}/refunds`, body: { mode: 'full', dest: 'cash', reason: 'Service issue' } })
    expect(refund.statusCode).toBe(403)
    expect((refund.json() as Json).code).toBe('KIOSK_FORBIDDEN')
    const voided = await kioskSend(w, { method: 'POST', url: `invoices/${v.invoiceId}/void`, body: { eventId: ev.id } })
    expect(voided.statusCode).toBe(403)
    expect((voided.json() as Json).code).toBe('KIOSK_FORBIDDEN')
    expect(await db().selectFrom('ledger_events').select('type').where('invoice_id', '=', v.invoiceId).where('type', 'in', ['refund', 'void']).execute()).toEqual([])
  })

  it('a saved-card charge confirmed on the kiosk is recorded in Marco’s name, ledger and charge row', async () => {
    const w = await kioskWorld()
    const res = await kioskSend(w, await SCENARIOS[`POST ${A}/invoices/:id/card-charges`]!.prepare(w))
    expect(res.statusCode, res.body).toBe(201)
    const charge = await db().selectFrom('square_charges').selectAll().executeTakeFirstOrThrow()
    expect(charge).toMatchObject({ decided_by: 'Marco R.', decided_by_user_id: null, decided_by_employee_id: w.marco.employeeId, decided_kiosk_device_id: w.device.id })
    const ev = await db().selectFrom('ledger_events').selectAll().where('id', '=', charge.ledger_event_id!).executeTakeFirstOrThrow()
    expect(ev).toMatchObject({ actor_user_id: null, actor_employee_id: w.marco.employeeId })
  })

  it('a text names Marco as its sender', async () => {
    const w = await kioskWorld()
    const v = await visit()
    const res = await kioskSend(w, { method: 'POST', url: `appointments/${v.appointmentId}/messages`, body: { text: 'Pulling your car around now.' } })
    expect(res.statusCode, res.body).toBe(201)
    const msg = await db().selectFrom('messages').select(['id', 'sender_employee_id', 'sender_kind']).where('appointment_id', '=', v.appointmentId).where('direction', '=', 'out').where('sender_kind', '=', 'staff').executeTakeFirstOrThrow()
    expect(msg.sender_employee_id).toBe(w.marco.employeeId)
    const ev = await db().selectFrom('staff_events').select(['message_id', 'kind']).where('kind', '=', 'text').executeTakeFirstOrThrow()
    expect(ev.message_id).toBe(msg.id)
  })
})

describe('signed-in staff are recorded too', () => {
  it('a signed-in person’s step is their own activity, via signed_in with their user', async () => {
    const v = await visit()
    const amara = await db().selectFrom('users').select(['id', 'employee_id']).where('email', '=', 'amara@example.test').executeTakeFirstOrThrow()
    expect((await m.send(sup(), 'POST', `/appointments/${v.appointmentId}/confirm`, {}, false)).statusCode).toBe(200)
    const ev = await db().selectFrom('staff_events').selectAll().where('kind', '=', 'confirm').executeTakeFirstOrThrow()
    expect(ev).toMatchObject({ employee_id: amara.employee_id, user_id: amara.id, via: 'signed_in', kiosk_device_id: null })
    const line = await db().selectFrom('activity_log').selectAll().where('appointment_id', '=', v.appointmentId).where('actor_type', '=', 'staff').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(line).toMatchObject({ actor_employee_id: amara.employee_id, kiosk_device_id: null })
  })
})

describe('the history backfill', () => {
  it('rebuilds the same events from the audit log and the messages, and running it again adds nothing', async () => {
    const w = await kioskWorld()
    for (const key of [
      `POST ${A}/appointments/:id/confirm`,
      `POST ${A}/appointments/:id/assign-bay`,
      `POST ${A}/appointments/:id/messages`,
      `POST ${A}/invoices/:id/payments`,
      `PUT ${A}/invoices/:id/tip`,
      `POST ${A}/customers`,
      `POST ${A}/appointments/:id/checklist/bulk`,
    ]) {
      const r = await kioskSend(w, await SCENARIOS[key]!.prepare(w))
      expect(r.statusCode, `${key}: ${r.body}`).toBeLessThan(300)
    }
    const pick = (rows: Record<string, unknown>[]) =>
      rows
        .filter((r) => r.kind !== 'worker_set')
        .map((r) => ({
          kind: r.kind,
          employee_id: r.employee_id,
          employee_name: r.employee_name,
          appointment_id: r.appointment_id,
          customer_id: r.customer_id,
          amount_cents: r.amount_cents,
          ledger_event_id: r.ledger_event_id,
          message_id: r.message_id,
          via: r.via,
          kiosk_device_id: r.kiosk_device_id,
          user_id: r.user_id,
          audit_id: r.audit_id,
        }))
        .sort((a, b) => `${a.kind}${a.audit_id}`.localeCompare(`${b.kind}${b.audit_id}`))
    const live = pick(await db().selectFrom('staff_events').selectAll().execute())
    expect(live.length).toBeGreaterThan(10)
    await db().deleteFrom('staff_events').execute()
    const first = await backfillStaffEvents(db())
    expect(first.inserted).toBeGreaterThan(10)
    expect(pick(await db().selectFrom('staff_events').selectAll().execute())).toEqual(live)
    const again = await backfillStaffEvents(db())
    expect(again.inserted).toBe(0)
    // a staff text from before texts were audited (no audit row) comes from the messages: a copy of the text under a new id
    const sent = await db().selectFrom('messages').select('id').where('sender_kind', '=', 'staff').where('direction', '=', 'out').executeTakeFirstOrThrow()
    const oldId = m.h.t.app.newId()
    await sql`insert into messages select (jsonb_populate_record(null::messages,
        to_jsonb(x) || jsonb_build_object('id', ${oldId}::uuid, 'idempotency_key', null))).*
      from messages x where x.id = ${sent.id}::uuid`.execute(db())
    const texts = await backfillStaffEvents(db())
    expect(texts.inserted).toBe(1)
    const old = await db().selectFrom('staff_events').selectAll().where('message_id', '=', oldId).executeTakeFirstOrThrow()
    expect(old).toMatchObject({ kind: 'text', employee_id: w.marco.employeeId, audit_id: null, via: 'signed_in' })
    expect((await backfillStaffEvents(db())).inserted).toBe(0)
  })
})
