// GET /appointments/:id: the appointment file (overview, add-ons with the catalog, checklist sections, photos with
// presigned thumbnails, activity, invoice summary, membership and visit history). Phone and email are masked for callers
// without cli.contact.
import { sql } from 'kysely'
import type { AuthContext } from '../../http/authorizer.js'
import type { Executor } from '../../platform/db.js'
import { atLabel, dateLabel, fmtT, minutesOfDay, toBizDate } from '../../platform/time.js'
import { maskEmail, maskPhone } from '../../platform/phone.js'
import { listCatalog } from '../catalog/service.js'
import '../customers/schema.js'
import type { AppointmentStatus } from '../customers/schema.js'
import { isVipCustomer } from '../customers/service.js'
import { canSeeContact } from '../people/redact.js'
import {
  LATE_META,
  STATUS_META,
  canDrag,
  customerBrief,
  isLate,
  listBays,
  requireAppointment,
  vehicleBrief,
} from './appointments.js'
import { loadChecklist, type ChecklistView } from './checklist.js'
import { loadSettingsBundle, type SchedulingCtx } from './context.js'
import { liveAddons, staffLabel } from './invoicing.js'
import { nextOf, payView, type NextStep, type PayView } from './board.js'
import { photoSummary, type PhotoSummary } from './photos.js'
import type { InvoiceSummary, MembershipInfo, UpgradeCandidacy } from './ports.js'

export interface ActivityEntry {
  id: number
  at: string
  atLabel: string
  text: string
  channels: string[]
  actorType: string
  actorName: string | null
}

export interface AppointmentFile {
  id: string
  seq: number
  version: number
  status: AppointmentStatus
  late: boolean
  badge: { label: string; color: string }
  canDrag: boolean
  next: { label: string; step: NextStep }
  customer: {
    id: string
    name: string
    initials: string
    phone: string | null
    email: string | null
    contactMasked: boolean
    vip: boolean
    smsOptedIn: boolean
    smsOptedOut: boolean
  }
  vehicle: {
    id: string
    year: number | null
    make: string | null
    model: string | null
    color: string | null
    plate: string | null
  } | null
  overview: {
    startsAt: string
    endsAt: string
    /** "10:00 AM". */
    time: string
    bizDate: string
    dateLabel: string
    service: { id: string; name: string; priceCents: number }
    durationMin: number
    durLabel: string
    source: string
    bay: { planned: { id: string; number: number } | null; actual: { id: string; number: number } | null }
    bayLabel: string
    staff: { id: string | null; name: string }
    etaMinutes: number | null
    prepped: boolean
    geoCheckedInAt: string | null
    arrivedAt: string | null
    cleaningStartedAt: string | null
    completedAt: string | null
    pickupState: 'pending' | 'collected' | null
    canceledAt: string | null
    cancelReason: string | null
    notes: string | null
    specialInstructions: string | null
    pay: PayView
  }
  addons: {
    selected: { id: string; serviceId: string; name: string; priceCents: number }[]
    catalog: { serviceId: string; name: string; priceCents: number; selected: boolean }[]
    totalCents: number
  }
  checklist: ChecklistView
  photos: PhotoSummary
  activity: ActivityEntry[]
  invoice: InvoiceSummary | null
  membership: MembershipInfo | null
  /** Set only when the client has no live membership: the real visit count behind the "strong upgrade candidate" card. */
  membershipUpgrade: UpgradeCandidacy | null
  history: {
    visitCount: number
    recent: { id: string; bizDate: string; service: string; status: string; priceCents: number }[]
  }
}

const initialsOf = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()

export async function loadAppointmentFile(
  db: Executor,
  c: SchedulingCtx,
  auth: AuthContext,
  id: string,
): Promise<AppointmentFile> {
  const a = await requireAppointment(db, c.locationId, id)
  const now = c.clock.now()
  const [
    customer,
    vehicle,
    bays,
    settings,
    addons,
    catalog,
    checklist,
    photos,
    invoiceMap,
    activityRows,
    vip,
    memberMap,
    staff,
  ] = await Promise.all([
    customerBrief(db, a.customerId),
    vehicleBrief(db, a.vehicleId),
    listBays(db, c.locationId),
    loadSettingsBundle(db, c.locationId),
    liveAddons(db, a.id),
    listCatalog(db, c.locationId),
    loadChecklist(db, a.id),
    photoSummary(db, c.ports.storage, a.id),
    c.ports.invoices.summariesFor(db, [a.id]),
    db
      .selectFrom('activity_log')
      .select(['id', 'at', 'text', 'channels', 'actor_type', 'actor_name'])
      .where('appointment_id', '=', a.id)
      .orderBy('at')
      .orderBy('id')
      .execute(),
    isVipCustomer(db, c.locationId, a.customerId),
    c.ports.memberships.forAppointments(db, [
      { appointmentId: a.id, customerId: a.customerId, membershipId: a.membershipId },
    ]),
    staffLabel(db, a.assignedEmployeeId),
  ])
  const history = await db
    .selectFrom('appointments')
    .select(['id', 'scheduled_start', 'package_name', 'status', 'price_cents'])
    .where('location_id', '=', c.locationId)
    .where('customer_id', '=', a.customerId)
    .where('status', '=', 'completed')
    .orderBy('scheduled_start', 'desc')
    .limit(8)
    .execute()
  const visits = await db
    .selectFrom('appointments')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('location_id', '=', c.locationId)
    .where('customer_id', '=', a.customerId)
    .where('status', '=', 'completed')
    .executeTakeFirstOrThrow()

  const member = memberMap.get(a.id) ?? null
  const upgrade = member
    ? null
    : ((
        await c.ports.memberships.upgradeCandidates?.(db, { locationId: c.locationId, now }, [
          { appointmentId: a.id, customerId: a.customerId, membershipId: a.membershipId },
        ])
      )?.get(a.id) ?? null)
  const invoice = invoiceMap.get(a.id) ?? null
  const unmasked = canSeeContact(auth)
  const bayOf = (bid: string | null) => {
    const b = bid ? bays.find((x) => x.id === bid) : undefined
    return b ? { id: b.id, number: b.number } : null
  }
  const planned = bayOf(a.plannedBayId)
  const actual = bayOf(a.bayId)
  const late = isLate(a, now, settings.ops.lateGraceMin)
  const meta = late ? LATE_META : STATUS_META[a.status]
  const selectedIds = new Set(addons.map((x) => x.serviceId))
  return {
    id: a.id,
    seq: a.seq,
    version: a.version,
    status: a.status,
    late,
    badge: { label: meta.label, color: meta.color },
    canDrag: canDrag(a.status),
    next: nextOf({ a, invoice }),
    customer: {
      id: customer.id,
      name: customer.fullName,
      initials: initialsOf(customer.fullName),
      phone: unmasked ? customer.phoneDisplay : customer.phoneE164 ? maskPhone(customer.phoneE164) : null,
      email: unmasked ? customer.email : customer.email ? maskEmail(customer.email) : null,
      contactMasked: !unmasked,
      vip,
      smsOptedIn: customer.smsOptedIn,
      smsOptedOut: customer.smsOptedOutAt !== null,
    },
    vehicle,
    overview: {
      startsAt: a.scheduledStart.toISOString(),
      endsAt: a.scheduledEnd.toISOString(),
      time: fmtT(minutesOfDay(a.scheduledStart, c.tz)),
      bizDate: toBizDate(a.scheduledStart, c.tz),
      dateLabel: dateLabel(a.scheduledStart, c.tz),
      service: { id: a.serviceId, name: a.packageName, priceCents: a.priceCents },
      durationMin: a.durationMin,
      durLabel: `Est. ${a.durationMin} min`,
      source: a.source,
      bay: { planned, actual },
      bayLabel: (actual ?? planned) ? `Bay ${(actual ?? planned)!.number}` : 'No bay',
      staff: { id: a.assignedEmployeeId, name: staff },
      etaMinutes: a.etaMinutes,
      prepped: a.bayPreppedAt !== null,
      geoCheckedInAt: a.geoCheckedInAt?.toISOString() ?? null,
      arrivedAt: a.arrivedAt?.toISOString() ?? null,
      cleaningStartedAt: a.cleaningStartedAt?.toISOString() ?? null,
      completedAt: a.completedAt?.toISOString() ?? null,
      pickupState: a.pickupState,
      canceledAt: a.canceledAt?.toISOString() ?? null,
      cancelReason: a.cancelReason,
      notes: a.notes,
      specialInstructions: a.specialInstructions,
      pay: payView(invoice),
    },
    addons: {
      selected: addons,
      catalog: catalog.addons.map((x) => ({
        serviceId: x.id,
        name: x.name,
        priceCents: x.priceCents,
        selected: selectedIds.has(x.id),
      })),
      totalCents: addons.reduce((n, x) => n + x.priceCents, 0),
    },
    checklist,
    photos,
    activity: activityRows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      atLabel: atLabel(r.at, now, c.tz),
      text: r.text,
      channels: r.channels,
      actorType: r.actor_type,
      actorName: r.actor_name,
    })),
    invoice,
    membership: member,
    membershipUpgrade: upgrade,
    history: {
      visitCount: visits.n,
      recent: history.map((h) => ({
        id: h.id,
        bizDate: toBizDate(h.scheduled_start, c.tz),
        service: h.package_name,
        status: h.status,
        priceCents: h.price_cents,
      })),
    },
  }
}
