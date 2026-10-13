// The client's own record (ADR 0160, design section 4): their appointments as refs, their open balance, their name (only while the
// welcome flow's placeholder stands) and their vehicles (added to their own record). The client is ctx.identity's, never an input.
import { sql } from 'kysely'
import { z } from 'zod/v4'
import { fmtT, minutesOfDay, toBizDate } from '../../../platform/time.js'
import { STATUS_PHRASE } from '../../scheduling/appointments.js'
import { TOOL_MIN_TRUST, type AssistantTool, type ToolInputs } from '../contract.js'
import { cleanPersonName, fail, json, ok, shortDate } from './common.js'
import { effectsOf } from './effects-live.js'

// the vehicle constants moved with set_my_vehicle's write (effects-live.ts, ADR 0174 §4b)
export { MAX_VEHICLES, TYPE_OF_SIZE } from './effects-live.js'

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

export { cleanPersonName } from './common.js'

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
    return effectsOf(ctx).saveName(ctx, name)
  },
}

const word = z.string().min(1).max(40)

export const setMyVehicle: AssistantTool<ToolInputs['set_my_vehicle']> = {
  name: 'set_my_vehicle',
  description:
    'Adds the client’s vehicle to their own record: size (a size key from SHOP FACTS "Vehicle sizes", as the client said it: never guess), make, model, and year and color when they said them (else null). Returns the price keys for that size.',
  input: z.strictObject({
    size: z.string().min(1).max(32),
    make: word,
    model: word,
    year: z.number().int().min(1950).max(2100).nullable(),
    color: z.string().max(30).nullable(),
  }),
  minTrust: TOOL_MIN_TRUST.set_my_vehicle,
  async run(ctx, input) {
    const customerId = ctx.identity.customerId
    if (!customerId) return fail('not_allowed', 'There is no client record for this number yet.')
    // facts-v4: the size is one of the shop's sizes (Settings → Vehicle sizes), checked against the facts the model read
    const sizes = ctx.facts.catalog.sizes
    const size = sizes.find((x) => x.key === input.size.trim().toLowerCase())
    if (!size)
      return fail('invalid', 'Use a size key from SHOP FACTS. Ask the client which size their car is if they did not say.', {
        detail: json({ sizes }),
      })
    const text = /^[\p{L}\p{N}][\p{L}\p{N} .'’&/+-]*$/u
    const make = input.make.replace(/\s+/g, ' ').trim()
    const model = input.model.replace(/\s+/g, ' ').trim()
    const color = input.color?.replace(/\s+/g, ' ').trim() || null
    if (!text.test(make) || !text.test(model) || (color !== null && !/^[\p{L} -]+$/u.test(color)))
      return fail('invalid', 'Use the plain make, model and color words.')
    const maxYear = new Date(ctx.now.getTime()).getUTCFullYear() + 1
    if (input.year !== null && input.year > maxYear) return fail('invalid', 'That model year is in the future.')
    return effectsOf(ctx).saveVehicle(ctx, { size, make, model, year: input.year, color })
  },
}
