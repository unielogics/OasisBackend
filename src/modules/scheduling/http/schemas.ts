// Zod 4 schemas of the Operations API: the card view model, snapshot, calendar, file and command results. Response
// schemas are enforced by the serializer, so they double as a contract test of the read models.
import { z } from '../../../http/zod.js'

export const Uuid = z.string().uuid()
export const Instant = z.string()
export const BizDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const Status = z.enum([
  'booked',
  'confirmed',
  'arrived',
  'cleaning',
  'completed',
  'canceled',
  'no_show',
])
export const BayRef = z.object({ id: z.string(), number: z.number().int() })
export const NextStep = z.enum(['confirm', 'arrive', 'start', 'complete', 'collect']).nullable()
export const Tone = z.enum(['red', 'amber', 'blue', 'green', 'violet'])

export const StaffRef = z.object({ id: z.string(), name: z.string(), initials: z.string() })

export const PayView = z.object({
  label: z.string(),
  kind: z.enum(['paid', 'deposit', 'due', 'none']),
  balanceCents: z.number().int(),
  invoiceNo: z.number().int().nullable(),
  status: z.string().nullable(),
})

export const InvoiceSummary = z.object({
  invoiceId: z.string(),
  invoiceNo: z.number().int(),
  subtotalCents: z.number().int(),
  taxCents: z.number().int(),
  tipCents: z.number().int(),
  totalCents: z.number().int(),
  paidCents: z.number().int(),
  balanceCents: z.number().int(),
  depositCents: z.number().int(),
  status: z.enum([
    'paid',
    'unpaid',
    'partially_paid',
    'partially_refunded',
    'refunded',
    'canceled',
    'canceled_kept',
    'canceled_refunded',
  ]),
  refundPending: z.boolean(),
  items: z.array(
    z.object({ name: z.string(), priceCents: z.number().int(), kind: z.enum(['package', 'addon']) }),
  ),
  payMethodLabel: z.string().nullable(),
})

export const Vehicle = z.object({
  year: z.number().int().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  color: z.string().nullable(),
  plate: z.string().nullable(),
})

export const OpsCard = z.object({
  id: z.string(),
  seq: z.number().int(),
  status: Status,
  late: z.boolean(),
  badge: z.object({ label: z.string(), color: z.string() }),
  customer: z.object({ id: z.string(), name: z.string() }),
  vip: z.boolean(),
  member: z.object({ plan: z.string(), label: z.string() }).nullable(),
  vehicle: Vehicle.nullable(),
  vehicleLine: z.string(),
  vehicleShort: z.string(),
  service: z.string(),
  startsAt: Instant,
  endsAt: Instant,
  time: z.string(),
  bizDate: BizDate,
  bay: BayRef.nullable(),
  bayLabel: z.string(),
  durationMin: z.number().int(),
  durLabel: z.string(),
  staff: StaffRef.nullable(),
  pay: PayView,
  hasNotes: z.boolean(),
  hasPhotos: z.boolean(),
  hasAddons: z.boolean(),
  addonCount: z.number().int(),
  next: z.object({ label: z.string(), step: NextStep }),
  canDrag: z.boolean(),
  etaMinutes: z.number().int().nullable(),
  prepped: z.boolean(),
  pickupState: z.enum(['pending', 'collected']).nullable(),
  version: z.number().int(),
})

export const Kpi = z.object({
  key: z.enum([
    'appointments24h',
    'activeJobs',
    'readyForPickup',
    'pendingPayments',
    'bayTimeFree',
    'membersToday',
    'revenueToday',
  ]),
  label: z.string(),
  value: z.string(),
  sub: z.string(),
  raw: z.number().int(),
})

export const Alert = z.object({
  key: z.string(),
  kind: z.string(),
  tone: Tone,
  glyph: z.string(),
  appointmentId: z.string().nullable(),
  priority: z.number().int(),
  title: z.string(),
  desc: z.string(),
  actionLabel: z.string(),
  action: z.object({ type: z.string(), appointmentId: z.string().nullable() }),
})

const BayOccupant = z.object({
  card: OpsCard,
  worker: StaffRef.nullable(),
  startedAt: Instant,
  elapsedSec: z.number().int(),
  elapsedLabel: z.string(),
  progressPct: z.number(),
  progressLabel: z.string(),
  durLabel: z.string(),
  estCompletion: Instant,
  estCompletionLabel: z.string(),
  overrun: z.boolean(),
})

export const BayCard = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  status: z.enum(['active', 'maintenance', 'blocked']),
  occupied: z.boolean(),
  free: z.boolean(),
  occupant: BayOccupant.nullable(),
  nextUp: z.string(),
  nextUpAppointmentId: z.string().nullable(),
})

export const OpsSnapshot = z.object({
  now: z.object({ iso: Instant, tz: z.string(), bizDate: BizDate, time: z.string(), dateLabel: z.string() }),
  window: z.enum(['next24', 'today', 'tomorrow', 'week']),
  q: z.string(),
  kpis: z.array(Kpi),
  alerts: z.array(Alert),
  inFacilityLabel: z.string(),
  timeline: z.object({
    count: z.number().int(),
    groups: z.array(
      z.object({
        key: z.string(),
        bizDate: BizDate,
        divider: z.string(),
        time: z.string(),
        ampm: z.string(),
        items: z.array(OpsCard),
      }),
    ),
  }),
  completed: z.object({ count: z.number().int(), items: z.array(OpsCard) }),
  queue: z.array(OpsCard),
  bays: z.array(BayCard),
  arrivals: z.array(
    z.object({
      appointmentId: z.string(),
      title: z.string(),
      desc: z.string(),
      vip: z.boolean(),
      etaMinutes: z.number().int(),
      bay: BayRef.nullable(),
      prepLabel: z.string(),
      prepped: z.boolean(),
    }),
  ),
  staff: z.array(
    z.object({
      employeeId: z.string().nullable(),
      name: z.string(),
      role: z.string(),
      initials: z.string(),
      avatarColor: z.string().nullable(),
      count: z.number().int(),
      jobs: z.array(OpsCard),
    }),
  ),
  emergency: z.object({ active: z.boolean(), summary: z.string().nullable(), startedAt: Instant.nullable() }),
})

const OpenWindow = z.object({
  openMin: z.number().int(),
  closeMin: z.number().int(),
  from: z.string(),
  to: z.string(),
})

export const CalendarSummary = z.object({
  from: BizDate,
  to: BizDate,
  total: z.number().int(),
  days: z.array(
    z.object({
      date: BizDate,
      weekday: z.number().int(),
      count: z.number().int(),
      closed: z.string().nullable(),
      reduced: z.boolean(),
      note: z.string(),
      open: OpenWindow.nullable(),
      needsRebook: z.number().int(),
      isToday: z.boolean(),
    }),
  ),
})

export const CalendarDay = z.object({
  date: BizDate,
  label: z.string(),
  isToday: z.boolean(),
  dayInfo: z.object({
    closed: z.string().nullable(),
    reduced: z.boolean(),
    note: z.string(),
    source: z.string(),
    open: OpenWindow.nullable(),
    h0: z.number().int().nullable(),
    h1: z.number().int().nullable(),
  }),
  sub: z.string(),
  count: z.number().int(),
  rows: z.array(
    z.object({ hour: z.number().int(), time: z.string(), ampm: z.string(), items: z.array(OpsCard) }),
  ),
  outsideHours: z.array(OpsCard),
  appointments: z.array(OpsCard),
})

export const Slot = z.object({
  time: z.string(),
  startMin: z.number().int(),
  start: Instant,
  endsAt: Instant,
  state: z.enum(['available', 'blocked', 'vip_held', 'closed', 'past', 'cutoff', 'outside_window']),
  reason: z.string().optional(),
  baysFree: z.number().int(),
  overridable: z.boolean(),
  overrideKind: z.enum(['capacity', 'vip_hold', 'hours', 'closure']).nullable(),
  releasesAt: Instant.optional(),
  sameDayEligible: z.boolean(),
})

export const Availability = z.object({
  date: BizDate,
  channel: z.enum(['desk', 'online']),
  isVip: z.boolean(),
  closed: z.boolean(),
  reason: z.string().nullable(),
  openMin: z.number().int().nullable(),
  closeMin: z.number().int().nullable(),
  durationMin: z.number().int(),
  slotMinutes: z.number().int(),
  releaseHours: z.number().int(),
  slots: z.array(Slot),
})

export const AppointmentCore = z.object({
  id: z.string(),
  seq: z.number().int(),
  version: z.number().int(),
  status: Status,
  scheduledStart: Instant,
  scheduledEnd: Instant,
  plannedBay: BayRef.nullable(),
  bay: BayRef.nullable(),
  assignedEmployeeId: z.string().nullable(),
  etaMinutes: z.number().int().nullable(),
  prepped: z.boolean(),
  pickupState: z.enum(['pending', 'collected']).nullable(),
  late: z.boolean(),
  canDrag: z.boolean(),
})

export const Toast = z.object({ title: z.string(), detail: z.string() })

export const CommandResult = z.object({
  appointment: AppointmentCore,
  toast: Toast,
  warnings: z.array(z.string()),
  invoice: InvoiceSummary.nullable().optional(),
  depositPolicy: z.enum(['keep', 'refund_card', 'refund_credit']).optional(),
})

export const BookingResult = z.object({
  appointment: AppointmentCore,
  customer: z.object({ id: z.string(), name: z.string(), created: z.boolean() }),
  invoice: InvoiceSummary,
  overrides: z.array(z.object({ kind: z.string(), reason: z.string() })),
  messageQueued: z.boolean(),
  toast: Toast,
})

const ChecklistItem = z.object({
  id: z.string(),
  label: z.string(),
  done: z.boolean(),
  position: z.number().int(),
})
export const ChecklistProgress = z.object({
  done: z.number().int(),
  total: z.number().int(),
  pct: z.number().int(),
  allDone: z.boolean(),
})
export const ChecklistView = ChecklistProgress.extend({
  sections: z.array(
    z.object({
      kind: z.enum(['package', 'addon']),
      title: z.string(),
      addonId: z.string().nullable(),
      items: z.array(ChecklistItem),
      done: z.number().int(),
      total: z.number().int(),
      allDone: z.boolean(),
    }),
  ),
})

const PhotoView = z.object({
  id: z.string(),
  category: z.enum(['arrival', 'before', 'after', 'issue']),
  note: z.string().nullable(),
  bytes: z.number().int().nullable(),
  takenAt: Instant,
  thumbUrl: z.string().nullable(),
  url: z.string().nullable(),
})
const PhotoCategory = z.object({ count: z.number().int(), items: z.array(PhotoView) })

export const AppointmentFile = z.object({
  id: z.string(),
  seq: z.number().int(),
  version: z.number().int(),
  status: Status,
  late: z.boolean(),
  badge: z.object({ label: z.string(), color: z.string() }),
  canDrag: z.boolean(),
  next: z.object({ label: z.string(), step: NextStep }),
  customer: z.object({
    id: z.string(),
    name: z.string(),
    initials: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    contactMasked: z.boolean(),
    vip: z.boolean(),
    smsOptedIn: z.boolean(),
    smsOptedOut: z.boolean(),
  }),
  vehicle: Vehicle.extend({ id: z.string() }).nullable(),
  overview: z.object({
    startsAt: Instant,
    endsAt: Instant,
    time: z.string(),
    bizDate: BizDate,
    dateLabel: z.string(),
    service: z.object({ id: z.string(), name: z.string(), priceCents: z.number().int() }),
    durationMin: z.number().int(),
    durLabel: z.string(),
    source: z.string(),
    bay: z.object({ planned: BayRef.nullable(), actual: BayRef.nullable() }),
    bayLabel: z.string(),
    staff: z.object({ id: z.string().nullable(), name: z.string() }),
    etaMinutes: z.number().int().nullable(),
    prepped: z.boolean(),
    geoCheckedInAt: Instant.nullable(),
    arrivedAt: Instant.nullable(),
    cleaningStartedAt: Instant.nullable(),
    completedAt: Instant.nullable(),
    pickupState: z.enum(['pending', 'collected']).nullable(),
    canceledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    notes: z.string().nullable(),
    specialInstructions: z.string().nullable(),
    pay: PayView,
  }),
  addons: z.object({
    selected: z.array(
      z.object({ id: z.string(), serviceId: z.string(), name: z.string(), priceCents: z.number().int() }),
    ),
    catalog: z.array(
      z.object({
        serviceId: z.string(),
        name: z.string(),
        priceCents: z.number().int(),
        selected: z.boolean(),
      }),
    ),
    totalCents: z.number().int(),
  }),
  checklist: ChecklistView,
  photos: z.object({
    arrival: PhotoCategory,
    before: PhotoCategory,
    after: PhotoCategory,
    issue: PhotoCategory,
  }),
  activity: z.array(
    z.object({
      id: z.number().int(),
      at: Instant,
      atLabel: z.string(),
      text: z.string(),
      channels: z.array(z.string()),
      actorType: z.string(),
      actorName: z.string().nullable(),
    }),
  ),
  invoice: InvoiceSummary.nullable(),
  membership: z
    .object({
      plan: z.string(),
      creditsLeft: z.number().int().nullable(),
      creditAvailable: z.boolean(),
      planKey: z.enum(['essential', 'premium', 'executive', 'exotic']).optional(),
      renewsAt: z.string().nullable().optional(),
      renewLabel: z.string().nullable().optional(),
      creditsUsed: z.number().int().optional(),
      perks: z.array(z.string()).optional(),
      color: z.string().optional(),
      bgColor: z.string().optional(),
      tint: z.string().optional(),
      memberMonths: z.number().int().optional(),
      retention: z.object({ label: z.string(), desc: z.string(), tone: z.enum(['green', 'red']) }).optional(),
    })
    .nullable(),
  history: z.object({
    visitCount: z.number().int(),
    recent: z.array(
      z.object({
        id: z.string(),
        bizDate: BizDate,
        service: z.string(),
        status: z.string(),
        priceCents: z.number().int(),
      }),
    ),
  }),
})

export const AddonChange = z.object({
  added: z.boolean(),
  changed: z.boolean(),
  addon: z.object({ serviceId: z.string(), name: z.string(), priceCents: z.number().int() }),
  invoice: InvoiceSummary,
  checklist: ChecklistProgress,
  toast: Toast,
})

export const ChecklistChange = z.object({ progress: ChecklistProgress, changed: z.number().int() })

export const BayView = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  status: z.enum(['active', 'maintenance', 'blocked']),
})

export const StaffView = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
  title: z.string(),
  avatarColor: z.string().nullable(),
})

export const OverrideBody = z.object({ reason: z.string().max(300) }).strict()
