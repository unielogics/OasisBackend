// The client's own record (ADR 0160, design section 4): their appointments as refs, their open balance, their name (only while the
// welcome flow's placeholder stands) and their vehicles (added to their own record). The client is ctx.identity's, never an input.
import { sql } from 'kysely'
import { z } from 'zod/v4'
import { transaction } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { fmtT, minutesOfDay, toBizDate } from '../../../platform/time.js'
import { listVehicles, updateCustomer, upsertVehicleByPlate } from '../../customers/service.js'
import { STATUS_PHRASE } from '../../scheduling/appointments.js'
import { TOOL_MIN_TRUST, type AssistantTool, type ToolInputs } from '../contract.js'
import { isProvisionalClient } from '../welcome/provisional.js'
import { VEHICLE_TYPES } from '../welcome/schema.js'
import '../welcome/schema.js'
import { fail, json, ok, shortDate } from './common.js'

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
  description: 'The client’s own open invoices and what is left to pay on each (not a price). For paying, offer send_link {kind: pay}.',
  input: z.strictObject({}),
  minTrust: TOOL_MIN_TRUST.get_balance,
  async run(ctx) {
    const customerId = ctx.identity.customerId
    if (!customerId) return ok({ openBalanceCents: 0, invoices: [] })
    const r = await sql<{ id: string; appointment_id: string | null; biz_date: string; balance: string; pending_amt: string; service: string | null }>`
      select i.id, i.appointment_id, i.biz_date::text as biz_date, c.balance, c.pending_amt, coalesce(s.public_name, a.package_name) as service
      from invoices i cross join lateral invoice_calc_of(i.id) c
      left join appointments a on a.id = i.appointment_id
      left join services s on s.id = a.service_id
      where i.customer_id = ${customerId} and i.location_id = ${ctx.identity.locationId} and i.canceled_at is null and c.balance > 0
      order by i.occurred_at desc, i.id desc
      limit 5`.execute(ctx.db)
    const refOf = new Map(ctx.refs.all().map((x) => [x.appointmentId, x.ref]))
    const invoices = r.rows.map((x) => ({
      ref: x.appointment_id ? (refOf.get(x.appointment_id) ?? null) : null,
      dateLabel: shortDate(x.biz_date),
      service: x.service,
      balanceCents: Number(x.balance),
      paymentPending: Number(x.pending_amt) > 0,
    }))
    const total = invoices.reduce((s, x) => s + x.balanceCents, 0)
    return ok(json({ openBalanceCents: total, invoices }), { amountsCents: [...new Set([total, ...invoices.map((x) => x.balanceCents)])] })
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
    'Saves the name a NEW client just told you (only while their record has no name yet; a name on file is never changed by text). Letters only, first and last name.',
  input: z.strictObject({ fullName: z.string().min(1).max(80) }),
  minTrust: TOOL_MIN_TRUST.set_my_name,
  async run(ctx, { fullName }) {
    const customerId = ctx.identity.customerId
    if (!customerId) return fail('not_allowed', 'There is no client record for this number yet.')
    const name = cleanPersonName(fullName)
    if (!name) return fail('invalid', 'That does not look like a person’s name. Ask for their first and last name.')
    return transaction(ctx.db, async (tx) => {
      // the record decides, not the turn's view: a name on file (or a client staff completed) is never replaced
      const locked = await tx.selectFrom('customers').select(['full_name', 'phone_e164']).where('id', '=', customerId).forUpdate().executeTakeFirst()
      if (!locked || locked.phone_e164 !== ctx.identity.phone || !(await isProvisionalClient(tx, customerId)))
        return fail('not_allowed', 'This client already has a name on file; it is not changed by text.')
      await updateCustomer(tx, { id: customerId, patch: { fullName: name, needsDetails: false } })
      await ctx.audit(tx, 'assistant.client.named', { entityType: 'customer', entityId: customerId, before: { name: locked.full_name }, after: { name } })
      return ok({ saved: true, firstName: name.split(' ')[0]! })
    })
  },
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
        .set({ vehicle_type: input.type, ...(same && input.year !== null && same.year === null ? { year: input.year } : {}), ...(same && color && !same.color ? { color } : {}) })
        .where('id', '=', vehicleId)
        .where('customer_id', '=', customerId)
        .execute()
      await ctx.audit(tx, same ? 'assistant.vehicle.updated' : 'assistant.vehicle.added', {
        entityType: 'vehicle',
        entityId: vehicleId,
        after: { customerId, type: input.type, year: input.year, make, model, color },
      })
      const tintClass = ctx.facts.catalog.tint.find((t) => t.vehicle === input.type)?.vehicleLabel ?? null
      return ok({ saved: true, vehicle: [input.year, make, model].filter((x) => x !== null).join(' '), type: input.type, tintClass })
    })
  },
}
