// An in-chat booking takes the size of the car the client names (ADR 0170, wave Q2): propose_booking stores the vehicle's id and size;
// the confirmed booking books that car by its id (no duplicate of a car without a plate) and prices the visit at its size. With no
// car named, the visit is priced at the smallest size and the confirmation says the exact price is confirmed at the shop.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import type { AnyAssistantTool, ToolOutcome } from '../../src/modules/assistant/contract.js'
import { createActionCodeHandler } from '../../src/modules/assistant/actions/handler.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import { useToolWorld, type CtxProbe } from './world.js'

const w = useToolWorld()
const tool = (name: string): AnyAssistantTool => createToolRegistry(w.deps).get(name)!
const maria = () => w.customer('Maria Delgado')
let n = 5000

async function run(name: string, probe: CtxProbe, input: unknown): Promise<ToolOutcome> {
  const t = tool(name)
  return t.run(probe.ctx, t.input.parse(input))
}

async function inbound(phone: string, text: string) {
  n += 1
  const ev = w.signed('sms:received', {
    messageId: `q2-size-in-${n}`,
    sender: phone,
    recipient: '+18623885827',
    simNumber: 1,
    message: text,
    receivedAt: w.clock.now().toISOString(),
  })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

async function lastCode(phone: string): Promise<string> {
  const r = await w.t.db
    .selectFrom('sms_outbox')
    .select('body')
    .where('to_e164', '=', phone)
    .where('klass', '=', 'action_confirm')
    .orderBy('queued_at', 'desc')
    .executeTakeFirstOrThrow()
  return /Reply (\d{4}) to confirm/.exec(r.body)![1]!
}

const reply = (phone: string, code: string, customerId: string) =>
  w.tx((tx) => createActionCodeHandler(w.deps).handle(tx, { locationId: w.locationId, phone, customerId, code, inboxId: w.newId(), at: w.clock.now() }))

async function trustedMaria(): Promise<CtxProbe> {
  await w.assistantOn({ actions: true })
  await w.trust(maria().phone, maria().id)
  await inbound(maria().phone, 'Can I book an express wash Monday at 10?')
  return w.ctx({ customerId: maria().id, phone: maria().phone, trust: 'trusted' })
}

async function washCells(): Promise<void> {
  await ensureVehicleClasses(w.t.db, w.locationId)
  const s = await w.t.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').executeTakeFirstOrThrow()
  await w.t.db.deleteFrom('service_class_prices').where('service_id', '=', s.id).execute()
  for (const [cls, cents] of [['compact_car', 4000], ['large_suv', 6000]] as const)
    await w.t.db.insertInto('service_class_prices').values({ service_id: s.id, location_id: w.locationId, class_key: cls, price_cents: cents }).execute()
}

const BOOK = { serviceKey: 'express-hand-wash', addonKeys: [], date: '2026-06-15', startMin: 600 }
const bookedText = async () =>
  (await w.t.db.selectFrom('messages').select(['template_key', 'body']).where('customer_id', '=', maria().id).where('template_key', '=', 'action_booked').executeTakeFirstOrThrow()).body

describe('an in-chat booking and the car’s size', () => {
  it('the car named on file supplies its size and is booked by its id: no duplicate of a car without a plate', async () => {
    await washCells()
    const car = w.newId()
    await w.t.db
      .insertInto('vehicles')
      .values({ id: car, customer_id: maria().id, year: null, make: 'Kia', model: 'Telluride', color: null, plate: null, deleted_at: null, vehicle_class: 'large_suv', vehicle_class_source: 'ai' })
      .execute()
    const before = await w.t.db.selectFrom('vehicles').select('id').where('customer_id', '=', maria().id).execute()
    const probe = await trustedMaria()
    const r = await run('propose_booking', probe, { ...BOOK, vehicle: 'the Telluride' })
    expect(r).toMatchObject({ ok: true })
    const action = await w.t.db.selectFrom('assistant_pending_actions').select('payload').orderBy('created_at', 'desc').executeTakeFirstOrThrow()
    expect(action.payload).toMatchObject({ vehicleId: car, vehicleClass: 'large_suv' })
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    const a = await w.t.db
      .selectFrom('appointments')
      .select(['vehicle_id', 'vehicle_class', 'price_cents', 'price_basis'])
      .where('customer_id', '=', maria().id)
      .executeTakeFirstOrThrow()
    expect(a).toEqual({ vehicle_id: car, vehicle_class: 'large_suv', price_cents: 6000, price_basis: 'class' })
    expect(await w.t.db.selectFrom('vehicles').select('id').where('customer_id', '=', maria().id).execute()).toHaveLength(before.length)
    expect(await bookedText()).not.toContain('exact price')
  })

  it('no car named: the smallest size’s price, and the confirmation says the exact price is confirmed at the shop', async () => {
    await washCells()
    const probe = await trustedMaria()
    await run('propose_booking', probe, { ...BOOK, vehicle: null })
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    const a = await w.t.db.selectFrom('appointments').select(['vehicle_class', 'price_cents', 'price_basis']).where('customer_id', '=', maria().id).executeTakeFirstOrThrow()
    expect(a).toEqual({ vehicle_class: null, price_cents: 4000, price_basis: 'unknown_class' })
    expect(await bookedText()).toMatch(/booking fee due at the shop\. We.ll confirm the exact price at the shop\. See you then!$/)
  })
})
