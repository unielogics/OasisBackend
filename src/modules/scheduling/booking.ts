// POST /appointments: customer upsert by phone, vehicle by plate, slot guard under an advisory lock, auto-planned bay,
// invoice through the gateway, checklist snapshot, booking message. All in the caller's (idempotent) transaction.
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import { fmtT, minutesOfDay, toBizDate, wallToInstant } from '../../platform/time.js'
import { refreshAppointmentCategories } from '../catalog/appointment-categories.js'
import { requireService } from '../catalog/service.js'
import '../customers/schema.js'
import type { AppointmentSource, SmsOptInSource } from '../customers/schema.js'
import {
  recordSmsOptIn,
  requireCustomer,
  upsertCustomerByPhone,
  upsertVehicleByPlate,
  type CustomerRecord,
} from '../customers/service.js'
import {
  getBay,
  listBays,
  logActivity,
  publishOps,
  requireAppointment,
  type AppointmentRecord,
} from './appointments.js'
import { audit } from './audit-helper.js'
import { candidateStarts, MS_PER_MIN, type Channel } from './availability.js'
import { loadDayData } from './availability-loader.js'
import { addAddonChecklist, snapshotPackageChecklist } from './checklist.js'
import { loadSettingsBundle, type Actor, type SchedulingCtx } from './context.js'
import { ensureInvoiceFor } from './invoicing.js'
import { toCore, type AppointmentCore, type Toast } from './lifecycle.js'
import type { InvoiceSummary } from './ports.js'
import type { TemplateVars } from '../messaging/templates/render.js'
import { checkSlot, recordOverrides, type AppliedOverride, type OverrideRequest } from './slots.js'
import {
  lineColumns,
  memberFor,
  notTheirVehicle,
  priceVisit,
  pricingView,
  recordVehicleClass,
  resolveVisitClass,
  type ClassSource,
  type PricingView,
} from './visit-pricing.js'

export interface BookingInput {
  customer: {
    id?: string
    name?: string | null
    phone?: string | null
    email?: string | null
    smsOptIn?: boolean
  }
  vehicle?: {
    year?: number | null
    make?: string | null
    model?: string | null
    color?: string | null
    plate?: string | null
  } | null
  /**
   * One of the customer's own vehicles (live): the visit's car instead of `vehicle` (ADR 0170, wave Q2: the assistant, the standing
   * series and the staff sheet name the car on file; no duplicate is created for a car without a plate).
   */
  vehicleId?: string | null
  /**
   * The size the visit is priced at (a size of the shop that is on; 422 otherwise). Absent or null: the vehicle's size on file,
   * else none (priced at the smallest size, "Confirm size").
   */
  vehicleClass?: string | null
  /**
   * When `vehicleClass` is given and the visit has a vehicle: record that size on the car with this source (the caller may write the
   * record). Absent: the car is left as it is (a guest's size prices the visit but never reaches someone else's record).
   */
  recordClassAs?: ClassSource | null
  /** false: priced as a guest whatever the customer's membership (a website booking that proved nothing). Absent: their membership. */
  memberPricing?: boolean
  serviceId: string
  addonIds?: string[]
  /** Exactly one of start and walkIn. */
  start?: Date
  walkIn?: boolean
  source?: AppointmentSource
  assignedEmployeeId?: string | null
  plannedBayId?: string | null
  notes?: string | null
  specialInstructions?: string | null
  override?: OverrideRequest | null
  /** The slot rules to apply: desk (default; overrides possible) or online (lead time, booking windows, paused days). */
  channel?: Channel
  /**
   * Whether the VIP slot rules apply (held times, the VIP booking window, the same-day guarantee). Absent: the customer's VIP flag
   * (vip_clients). The public website passes what the caller proved: false without a verified member token.
   */
  vip?: boolean
  /** The customer text queued instead of the booking thanks (the website's confirmation); none when `null`. */
  message?: { templateKey: string; vars: TemplateVars } | null
  /**
   * The variable of `message` set to "yes" when the size is unknown or has no price of its own (ADR 0170: the confirmation says the
   * exact price is confirmed at the shop).
   */
  confirmPriceVar?: string
  /**
   * A link page or the assistant books for a session verified with this client's own PIN (ADR 0160, W4c fixes): the stale-record
   * rule counts the visit as the client's activity (a booking proven only by the number never is).
   */
  bookedWithPin?: boolean
}

export interface BookingResult {
  appointment: AppointmentCore
  customer: { id: string; name: string; created: boolean }
  invoice: InvoiceSummary
  overrides: AppliedOverride[]
  messageQueued: boolean
  toast: Toast
  /** What the visit was priced at (ADR 0170): the size, the flags, the totals before tax. */
  pricing: PricingView
}

const bad = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

const clean = (s: string | null | undefined): string | null => {
  const t = s?.trim()
  return t ? t : null
}

/** A walk-in starts at the next slot on the grid (now itself when it is on the grid). */
async function walkInStart(tx: Tx, c: SchedulingCtx): Promise<Date> {
  const now = c.clock.now()
  const date = toBizDate(now, c.tz)
  const data = await loadDayData(tx, { locationId: c.locationId, tz: c.tz, now, date })
  const next = candidateStarts(data.day, data.settings.rules)
    .map((m) => wallToInstant(date, m, c.tz))
    .find((d) => d.getTime() >= now.getTime())
  return next ?? now
}

/** The active bay with the fewest planned or occupying jobs overlapping the interval (ties: lowest number). */
export async function autoPlanBay(
  tx: Tx,
  c: SchedulingCtx,
  start: Date,
  end: Date,
  bufferMin: number,
  excludeId?: string,
): Promise<string | null> {
  const bays = (await listBays(tx, c.locationId)).filter((b) => b.status === 'active')
  if (bays.length === 0) return null
  const from = new Date(start.getTime() - bufferMin * MS_PER_MIN)
  const to = new Date(end.getTime() + bufferMin * MS_PER_MIN)
  const rows = await tx
    .selectFrom('appointments')
    .select(['planned_bay_id', 'bay_id'])
    .where('location_id', '=', c.locationId)
    .where('status', 'in', ['booked', 'confirmed', 'arrived', 'cleaning'])
    .where('scheduled_start', '<', to)
    .where('scheduled_end', '>', from)
    .$if(excludeId !== undefined, (q) => q.where('id', '<>', excludeId!))
    .execute()
  const load = new Map(bays.map((b) => [b.id, 0]))
  for (const r of rows) {
    const id = r.bay_id ?? r.planned_bay_id
    if (id && load.has(id)) load.set(id, load.get(id)! + 1)
  }
  return [...bays].sort((a, b) => load.get(a.id)! - load.get(b.id)! || a.number - b.number)[0]!.id
}

async function resolveCustomer(
  tx: Tx,
  c: SchedulingCtx,
  input: BookingInput,
): Promise<{ customer: CustomerRecord; created: boolean }> {
  const walkIn = input.walkIn === true
  const web = input.source === 'online'
  const optIn: SmsOptInSource = web ? 'online' : walkIn ? 'walk_in' : 'dashboard'
  const now = c.clock.now()
  if (input.customer.id) {
    let customer = await requireCustomer(tx, input.customer.id)
    if (customer.deletedAt || customer.mergedInto)
      throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
    if (input.customer.smsOptIn && !customer.smsOptedIn && customer.smsOptedOutAt === null)
      customer = await recordSmsOptIn(tx, customer.id, optIn, now)
    return { customer, created: false }
  }
  const phone = clean(input.customer.phone)
  if (!phone && !walkIn) throw bad('customer.phone', 'Enter a valid mobile number.')
  const r = await upsertCustomerByPhone(tx, {
    newId: c.newId,
    now,
    fullName: input.customer.name,
    phone,
    email: input.customer.email,
    source: web ? 'online' : walkIn ? 'walk_in' : 'dashboard',
    smsOptIn: input.customer.smsOptIn ? optIn : null,
  })
  return { customer: r.customer, created: r.created }
}

export async function createAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  input: BookingInput,
): Promise<BookingResult> {
  if ((input.start === undefined) === (input.walkIn !== true))
    throw bad('start', 'Send either a start time or walkIn.')
  const pkg = await requireService(tx, c.locationId, input.serviceId)
  if (pkg.kind !== 'package' || !pkg.active) throw bad('serviceId', 'Pick an available package.')
  const addons = []
  for (const id of [...new Set(input.addonIds ?? [])]) {
    const a = await requireService(tx, c.locationId, id)
    if (a.kind !== 'addon' || !a.active) throw bad('addonIds', 'Pick add-ons from the catalog.')
    addons.push(a)
  }
  if (input.assignedEmployeeId) {
    const e = await tx
      .selectFrom('employees')
      .select(['id', 'status'])
      .where('id', '=', input.assignedEmployeeId)
      .executeTakeFirst()
    if (!e || e.status !== 'active') throw bad('assignedEmployeeId', 'Pick an active team member.')
  }
  if (input.plannedBayId) {
    const bay = await getBay(tx, c.locationId, input.plannedBayId)
    if (!bay) throw bad('plannedBayId', 'That bay does not exist.')
    if (bay.status !== 'active') throw new AppError('BAY_UNAVAILABLE', { params: { n: bay.number } })
  }

  const { customer, created } = await resolveCustomer(tx, c, input)
  const v = input.vehicle
  const hasVehicle =
    !!v && [v.make, v.model, v.plate, v.color, v.year].some((x) => x !== undefined && x !== null && x !== '')
  let vehicle: { id: string; vehicleClass: string | null; source: string | null } | null = null
  if (input.vehicleId) {
    const own = isUuid(input.vehicleId)
      ? await tx
          .selectFrom('vehicles')
          .select(['id', 'vehicle_class', 'vehicle_class_source'])
          .where('id', '=', input.vehicleId)
          .where('customer_id', '=', customer.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
      : undefined
    if (!own) throw notTheirVehicle('vehicleId')
    vehicle = { id: own.id, vehicleClass: own.vehicle_class, source: own.vehicle_class_source }
  } else if (hasVehicle) {
    const up = (
      await upsertVehicleByPlate(tx, {
        newId: c.newId,
        customerId: customer.id,
        year: v!.year ?? null,
        make: v!.make,
        model: v!.model,
        color: v!.color,
        plate: v!.plate,
      })
    ).vehicle
    const row = await tx.selectFrom('vehicles').select(['vehicle_class', 'vehicle_class_source']).where('id', '=', up.id).executeTakeFirstOrThrow()
    vehicle = { id: up.id, vehicleClass: row.vehicle_class, source: row.vehicle_class_source }
  }
  // the size: the one named, else the car's on file (ADR 0170); recorded on the car only when the caller may write the record. A size
  // staff set on the car outranks one a client, the website or the assistant names (review Q4 SEC-2): the visit is priced at the staff
  // size and the board notes what the client said
  const staffSize = vehicle && vehicle.source === 'staff' && vehicle.vehicleClass ? vehicle.vehicleClass : null
  const overruled = !!input.vehicleClass && input.recordClassAs !== 'staff' && staffSize !== null && input.vehicleClass !== staffSize
  const named = await resolveVisitClass(tx, c.locationId, { explicit: input.vehicleClass, vehicleClass: vehicle?.vehicleClass })
  const staffOn = overruled ? await resolveVisitClass(tx, c.locationId, { vehicleClass: staffSize }) : null
  const classKey = staffOn ?? named
  if (input.vehicleClass && vehicle && input.recordClassAs) await recordVehicleClass(tx, vehicle.id, classKey!, input.recordClassAs)
  const member = await memberFor(tx, c, customer.id, input.memberPricing !== false)
  const priced = await priceVisit(tx, c, { packageId: pkg.id, addonIds: addons.map((a) => a.id), classKey, member })
  const pkgLine = priced.quote.lines[0]!

  const start = input.start ?? (await walkInStart(tx, c))
  const end = new Date(start.getTime() + pkg.durationMin * MS_PER_MIN)
  const decision = await checkSlot(tx, c, actor, {
    start,
    durationMin: pkg.durationMin,
    customerId: customer.id,
    override: input.override,
    channel: input.channel,
    vip: input.vip,
  })
  const { rules } = await loadSettingsBundle(tx, c.locationId)
  const plannedBayId =
    input.plannedBayId ??
    (rules.autoPlanBay ? await autoPlanBay(tx, c, start, end, rules.bufferMinutes) : null)

  const id = c.newId()
  await tx
    .insertInto('appointments')
    .values({
      id,
      location_id: c.locationId,
      customer_id: customer.id,
      vehicle_id: vehicle?.id ?? null,
      service_id: pkg.id,
      package_name: pkg.name,
      ...lineColumns(pkgLine),
      vehicle_class: priced.classKey,
      vehicle_class_label: priced.classLabel,
      membership_id: member?.membershipId ?? null,
      duration_min: pkg.durationMin,
      scheduled_start: start,
      scheduled_end: end,
      assigned_employee_id: input.assignedEmployeeId ?? null,
      planned_bay_id: plannedBayId,
      source: input.source ?? (input.walkIn ? 'walk_in' : 'dashboard'),
      notes: clean(input.notes),
      special_instructions: clean(input.specialInstructions),
      booked_with_pin: input.bookedWithPin === true,
      // a job's system actor is not a users row
      created_by: isUuid(actor.auth.userId) ? actor.auth.userId : null,
    })
    .execute()
  for (const [i, a] of addons.entries()) {
    const rowId = c.newId()
    await tx
      .insertInto('appointment_addons')
      .values({
        id: rowId,
        appointment_id: id,
        service_id: a.id,
        name: a.name,
        ...lineColumns(priced.quote.lines[i + 1]!),
        added_by: isUuid(actor.auth.userId) ? actor.auth.userId : null,
      })
      .execute()
  }
  await snapshotPackageChecklist(tx, c, id, pkg)
  const rows = await tx
    .selectFrom('appointment_addons')
    .select(['id', 'service_id'])
    .where('appointment_id', '=', id)
    .orderBy('added_at')
    .orderBy('id')
    .execute()
  for (const a of addons) {
    const row = rows.find((r) => r.service_id === a.id)!
    await addAddonChecklist(tx, c, id, row.id, a)
  }
  // the categories of the package and add-ons (ADR 0160): the board's chips, the filter and the KPIs read them
  await refreshAppointmentCategories(tx, id)
  await recordOverrides(tx, c, actor, id, decision)

  const appt: AppointmentRecord = await requireAppointment(tx, c.locationId, id)
  const invoice = await ensureInvoiceFor(tx, c, appt, actor)
  await logActivity(tx, c, {
    appointmentId: id,
    text: input.walkIn ? 'Walk-in booked' : 'Booking created',
    channels: ['system'],
    actor,
  })
  if (staffOn && named && staffOn !== named) {
    const labels = await tx.selectFrom('vehicle_classes').select(['key', 'label']).where('location_id', '=', c.locationId).where('key', 'in', [named, staffOn]).execute()
    const label = (k: string) => labels.find((x) => x.key === k)?.label ?? k
    await logActivity(tx, c, {
      appointmentId: id,
      text: `Size · the client chose ${label(named)}; staff set ${label(staffOn)} for this car, so it is priced at ${label(staffOn)}`,
      channels: ['internal'],
      actor,
    })
  }
  for (const o of decision.overrides)
    await logActivity(tx, c, {
      appointmentId: id,
      text: `Override · ${o.kind.replace(/_/g, ' ')} · ${o.reason}`,
      channels: ['internal'],
      actor,
    })
  // a standing visit is booked by the materializer every few weeks; thanking the client each time would be noise
  const view = pricingView(priced)
  const message =
    input.message === undefined
      ? { templateKey: 'booking_thanks', vars: { first: customer.fullName.trim().split(/\s+/)[0] } }
      : input.message && input.confirmPriceVar && view.confirmAtShop
        ? { ...input.message, vars: { ...input.message.vars, [input.confirmPriceVar]: 'yes' } }
        : input.message
  const sent =
    input.source === 'standing' || message === null
      ? { queued: false }
      : await c.ports.messages.enqueue(tx, {
          customerId: customer.id,
          appointmentId: id,
          templateKey: message.templateKey,
          vars: message.vars,
          purpose: 'booking',
        })
  if (sent.queued)
    await logActivity(tx, c, {
      appointmentId: id,
      text: message?.templateKey === 'booking_thanks' ? 'Booking thanks sent' : 'Booking confirmation sent',
      channels: ['sms'],
      actor,
    })
  await audit(tx, c, actor, 'create', id, null, {
    customerId: customer.id,
    serviceId: pkg.id,
    start: start.toISOString(),
    source: appt.source,
    overrides: decision.overrides.map((o) => ({ kind: o.kind, reason: o.reason })),
    vehicleClass: priced.classKey,
    priceCents: priced.quote.totals.listCents - priced.quote.totals.discountCents,
    member: member !== null,
  })
  await publishOps(tx, c.locationId, {
    appointment: { id, version: appt.version, status: appt.status, change: 'created' },
    availability: [decision.bizDate],
  })
  return {
    appointment: await toCore(tx, c, appt),
    customer: { id: customer.id, name: customer.fullName, created },
    invoice,
    overrides: decision.overrides,
    messageQueued: sent.queued,
    toast: { title: 'Appointment booked', detail: `${pkg.name} · ${fmtT(minutesOfDay(start, c.tz))}` },
    pricing: view,
  }
}
