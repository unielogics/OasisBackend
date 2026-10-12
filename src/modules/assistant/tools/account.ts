// The client's own record (ADR 0160, design section 4): their appointments as refs, their open balance, their name (only while the
// welcome flow's placeholder stands) and their vehicles (added to their own record). The client is ctx.identity's, never an input.
import { sql } from 'kysely'
import { z } from 'zod/v4'
import { transaction, type Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { fmtT, minutesOfDay, toBizDate } from '../../../platform/time.js'
import { listVehicles, updateCustomer, upsertVehicleByPlate } from '../../customers/service.js'
import { STATUS_PHRASE } from '../../scheduling/appointments.js'
import { TOOL_MIN_TRUST, type AssistantTool, type ToolInputs } from '../contract.js'
import { isProvisionalClient } from '../welcome/provisional.js'
import { VEHICLE_TYPES, type VehicleType } from '../welcome/schema.js'
import { tintPlaceholder } from '../facts.js'
import '../welcome/schema.js'
import { fail, json, ok, shortDate } from './common.js'

/** The vehicle size (ADR 0170, migration 20261014100000) a set_my_vehicle type maps to until facts-v4 (wave Q3d) names sizes. */
export const SIZE_OF_TYPE: Readonly<Record<VehicleType, string>> = {
  sedan_coupe: 'compact_car',
  suv_crossover: 'compact_suv',
  truck_van: 'truck',
}

/**
 * The tint rows of a vehicle class. set_my_vehicle's types (sedan_coupe | suv_crossover | truck_van, vehicles.vehicle_type)
 * are the price classes; the tint rows are keyed by vehicle size since ADR 0170 (compact_car, compact_suv, truck: the type's
 * size), and by the old matrix's own keys before ("sedan", "suv", "truck"), so a class matches its size, its own key or the key of
 * its first word.
 */
export function tintRowsFor<R extends { vehicle: string }>(tint: readonly R[], type: VehicleType): R[] {
  const keys = new Set([SIZE_OF_TYPE[type], type, type.split('_')[0]!])
  return tint.filter((t) => keys.has(t.vehicle))
}

/** Vehicles a client may have added by text in all (the record is theirs; a flood of vehicles is not). */
export const MAX_VEHICLES = 6

export const listMyAppointments: AssistantTool<ToolInputs['list_my_appointments']> = {
  name: 'list_my_appointments',
  description: 'The client’s own upcoming visits (and the latest past one) as A1..A3 with date, time, service, add-ons and status.',
  input: z.strictObject({}),
  minTrust: TOOL_MIN_TRUST.list_my_appointments,
  async run(ctx) {
    const refs = ctx.refs.all()
    if (!ctx.identity.customerId || refs.length === 0) return ok({ appointments: [] })
    const tz = ctx.scheduling.tz
    const ids = refs.map((r) => r.appointmentId)
    const rows = await ctx.db
      .selectFrom('appointments as a')
      .leftJoin('services as s', 's.id', 'a.service_id')
      .select(['a.id', 'a.customer_id', 'a.status', 'a.scheduled_start', 'a.package_name', 's.public_name'])
      .where('a.id', 'in', ids)
      .where('a.customer_id', '=', ctx.identity.customerId)
      .execute()
    const addons = await ctx.db.selectFrom('appointment_addons').select(['appointment_id', 'name']).where('appointment_id', 'in', ids).orderBy('added_at').execute()
    const list = refs.flatMap(({ ref, appointmentId }) => {
      const a = rows.find((r) => r.id === appointmentId)
      if (!a) return []
      const date = toBizDate(a.scheduled_start, tz)
      return [
        {
          ref,
          date,
          dateLabel: shortDate(date),
          time: fmtT(minutesOfDay(a.scheduled_start, tz)),
          service: a.public_name ?? a.package_name,
          addons: addons.filter((x) => x.appointment_id === a.id).map((x) => x.name),
          status: STATUS_PHRASE[a.status],
          upcoming: a.scheduled_start.getTime() > ctx.now.getTime() && ['booked', 'confirmed'].includes(a.status),
        },
      ]
    })
    return ok(json({ appointments: list }))
  },
}

export const getBalance: AssistantTool<ToolInputs['get_balance']> = {
  name: 'get_balance',
  description:
    'The client’s own open invoices (visit, date, whether a payment is on its way). To state what they owe, write "{balance}." as its own sentence: the server writes the open balance. For paying, offer send_link {kind: pay}.',
  input: z.strictObject({}),
  minTrust: TOOL_MIN_TRUST.get_balance,
  async run(ctx) {
    const customerId = ctx.identity.customerId
    // the model never sees an amount (guard v4): {balance} renders the total the runner takes from amountsCents[0]
    if (!customerId) return ok({ hasOpenBalance: false, invoices: [] }, { amountsCents: [0] })
    const r = await sql<{ id: string; appointment_id: string | null; biz_date: string; balance: string; pending_amt: string; service: string | null }>`
      select i.id, i.appointment_id, i.biz_date::text as biz_date, c.balance, c.pending_amt, coalesce(s.public_name, a.package_name) as service
      from invoices i cross join lateral invoice_calc_of(i.id) c
      left join appointments a on a.id = i.appointment_id
      left join services s on s.id = a.service_id
      where i.customer_id = ${customerId} and i.location_id = ${ctx.identity.locationId} and i.canceled_at is null and c.balance > 0
      order by i.occurred_at desc, i.id desc
      limit 5`.execute(ctx.db)
    const refOf = new Map(ctx.refs.all().map((x) => [x.appointmentId, x.ref]))
    const balances = r.rows.map((x) => Number(x.balance))
    const invoices = r.rows.map((x) => ({
      ref: x.appointment_id ? (refOf.get(x.appointment_id) ?? null) : null,
      dateLabel: shortDate(x.biz_date),
      service: x.service,
      paymentPending: Number(x.pending_amt) > 0,
    }))
    const total = balances.reduce((s, x) => s + x, 0)
    return ok(
      json({
        hasOpenBalance: total > 0,
        invoices,
        balanceRule: 'Never write an amount: write "{balance}." as its own sentence and the server writes "Your open balance is ...". Never add up or split it.',
      }),
      { amountsCents: [...new Set([total, ...balances])] },
    )
  },
}

/** A person's name as typed: letters (any alphabet), spaces, apostrophes, hyphens and periods; one to four words. */
export function cleanPersonName(raw: string): string | null {
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (name.length < 2 || name.length > 60) return null
  if (!/^\p{L}[\p{L}\p{M}'’ .-]*$/u.test(name)) return null
  const words = name.split(' ')
  if (words.length > 4 || words.some((w) => !/\p{L}/u.test(w))) return null
  return name
}

export const setMyName: AssistantTool<ToolInputs['set_my_name']> = {
  name: 'set_my_name',
  description:
    'Saves the name a NEW client told you, exactly as they gave it: their first name, plus their last name ONLY if they said it (never invent, guess or repeat one). While the record still has no name, or when they correct a name you saved in this conversation, it saves it; a name on file otherwise is never changed by text. Letters only.',
  input: z.strictObject({ fullName: z.string().min(1).max(80) }),
  minTrust: TOOL_MIN_TRUST.set_my_name,
  async run(ctx, { fullName }) {
    const customerId = ctx.identity.customerId
    if (!customerId) return fail('not_allowed', 'There is no client record for this number yet.')
    const name = cleanPersonName(fullName)
    if (!name) return fail('invalid', 'That does not look like a person’s name. Ask for their first name.')
    return transaction(ctx.db, async (tx) => {
      // the record decides, not the turn's view: a name on file (or a client staff completed) is never replaced; the one exception
      // (W4b X7) is the client correcting the name the assistant itself saved in this conversation, while it still stands as saved
      const locked = await tx
        .selectFrom('customers')
        .select(['full_name', 'phone_e164'])
        .where('id', '=', customerId)
        .forUpdate()
        .executeTakeFirst()
      if (!locked || locked.phone_e164 !== ctx.identity.phone)
        return fail('not_allowed', 'There is no client record for this number.')
      const provisional = await isProvisionalClient(tx, customerId)
      if (
        !provisional &&
        !(await namedInThisConversation(tx, {
          conversationId: ctx.conversationId,
          customerId,
          current: locked.full_name,
        }))
      )
        return fail('not_allowed', 'This client already has a name on file; it is not changed by text.')
      if (!provisional && locked.full_name === name)
        return ok({ saved: true, firstName: name.split(' ')[0]!, unchanged: true })
      await updateCustomer(tx, { id: customerId, patch: { fullName: name, needsDetails: false } })
      await ctx.audit(tx, provisional ? 'assistant.client.named' : 'assistant.client.renamed', {
        entityType: 'customer',
        entityId: customerId,
        before: { name: locked.full_name },
        after: { name },
      })
      return ok({ saved: true, firstName: name.split(' ')[0]! })
    })
  },
}

/**
 * Whether the client's current name is the one set_my_name saved in this conversation (its last successful call, cleaned the same
 * way): then the client may still correct it by text (W4b X7: a model padded "Rosa Rosa" and the client's "Rosa Garcia" was
 * refused). A name staff changed since, or one from before the conversation, is never changed by text.
 */
async function namedInThisConversation(
  tx: Tx,
  o: { conversationId: string; customerId: string; current: string },
): Promise<boolean> {
  const last = await tx
    .selectFrom('assistant_tool_calls as c')
    .innerJoin('assistant_turns as t', 't.id', 'c.turn_id')
    .select(['c.input'])
    .where('t.conversation_id', '=', o.conversationId)
    .where('c.tool', '=', 'set_my_name')
    .where('c.outcome', '=', 'ok')
    .orderBy('c.created_at', 'desc')
    .orderBy('c.seq', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!last) return false
  const input = (typeof last.input === 'string' ? JSON.parse(last.input) : last.input) as {
    fullName?: unknown
  }
  return typeof input.fullName === 'string' && cleanPersonName(input.fullName) === o.current
}

const word = z.string().min(1).max(40)

export const setMyVehicle: AssistantTool<ToolInputs['set_my_vehicle']> = {
  name: 'set_my_vehicle',
  description:
    'Adds the client’s vehicle to their own record: type (sedan_coupe, suv_crossover or truck_van: the tint price class), make, model, and year and color when they said them (else null).',
  input: z.strictObject({
    type: z.enum(VEHICLE_TYPES as unknown as ['sedan_coupe', 'suv_crossover', 'truck_van']),
    make: word,
    model: word,
    year: z.number().int().min(1950).max(2100).nullable(),
    color: z.string().max(30).nullable(),
  }),
  minTrust: TOOL_MIN_TRUST.set_my_vehicle,
  async run(ctx, input) {
    const customerId = ctx.identity.customerId
    if (!customerId) return fail('not_allowed', 'There is no client record for this number yet.')
    const text = /^[\p{L}\p{N}][\p{L}\p{N} .'’&/+-]*$/u
    const make = input.make.replace(/\s+/g, ' ').trim()
    const model = input.model.replace(/\s+/g, ' ').trim()
    const color = input.color?.replace(/\s+/g, ' ').trim() || null
    if (!text.test(make) || !text.test(model) || (color !== null && !/^[\p{L} -]+$/u.test(color)))
      return fail('invalid', 'Use the plain make, model and color words.')
    const maxYear = new Date(ctx.now.getTime()).getUTCFullYear() + 1
    if (input.year !== null && input.year > maxYear) return fail('invalid', 'That model year is in the future.')
    return transaction(ctx.db, async (tx) => {
      const owner = await tx.selectFrom('customers').select('phone_e164').where('id', '=', customerId).forUpdate().executeTakeFirst()
      if (!owner || owner.phone_e164 !== ctx.identity.phone) return fail('not_allowed', 'There is no client record for this number.')
      const vehicles = await listVehicles(tx, customerId)
      const same = vehicles.find(
        (v) => (v.make ?? '').toLowerCase() === make.toLowerCase() && (v.model ?? '').toLowerCase() === model.toLowerCase() && (input.year === null || v.year === input.year),
      )
      if (!same && vehicles.length >= MAX_VEHICLES) return fail('rate_limited', 'This client has many vehicles on file already; the team can add more.')
      let vehicleId: string
      try {
        vehicleId = same
          ? same.id
          : (await upsertVehicleByPlate(tx, { newId: ctx.newId, customerId, year: input.year, make, model, color, plate: null })).vehicle.id
      } catch (e) {
        if (e instanceof AppError && e.code === 'VALIDATION_FAILED') return fail('invalid', 'That vehicle could not be saved.')
        throw e
      }
      await tx
        .updateTable('vehicles')
        .set({
          vehicle_type: input.type,
          // the size the type maps to (ADR 0170), unless staff set one
          vehicle_class: sql<string>`case when vehicle_class_source = 'staff' then vehicle_class else ${SIZE_OF_TYPE[input.type]} end`,
          vehicle_class_source: sql<'staff' | 'ai'>`case when vehicle_class_source = 'staff' then 'staff' else 'ai' end`,
          ...(same && input.year !== null && same.year === null ? { year: input.year } : {}),
          ...(same && color && !same.color ? { color } : {}),
        })
        .where('id', '=', vehicleId)
        .where('customer_id', '=', customerId)
        .execute()
      await ctx.audit(tx, same ? 'assistant.vehicle.updated' : 'assistant.vehicle.added', {
        entityType: 'vehicle',
        entityId: vehicleId,
        after: { customerId, type: input.type, year: input.year, make, model, color },
      })
      const rows = tintRowsFor(ctx.facts.catalog.tint, input.type)
      return ok({
        saved: true,
        vehicle: [input.year, make, model].filter((x) => x !== null).join(' '),
        type: input.type,
        tintClass: rows[0]?.vehicleLabel ?? null,
        // the tint prices for their vehicle class, as placeholders (the model never writes an amount)
        tintPriceKeys: rows.map((r) => ({ film: r.filmLabel, priceKey: tintPlaceholder(r.vehicle, r.film) })),
      })
    })
  },
}
