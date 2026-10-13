// Zod 4 schemas of the Operations API: the card view model, snapshot, calendar, file and command results. Response
// schemas are enforced by the serializer, so they double as a contract test of the read models.
import { z } from '../../../http/zod.js'
import { DepositView, InvoiceProcessing } from '../../payments/http/tender-schemas.js'

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
  kind: z.enum(['paid', 'deposit', 'due', 'pending', 'none']),
  balanceCents: z.number().int(),
  awaitingCents: z.number().int(),
  invoiceNo: z.number().int().nullable(),
  status: z.string().nullable(),
  processing: InvoiceProcessing.optional().describe('The invoice’s processor and usable Square tenders (as its summary); absent without an invoice'),
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
  awaitingCents: z.number().int().optional(),
  taxBp: z.number().int().optional().describe('Deprecated (ADR 0173): the rate rounded to whole basis points. Use taxDbp.'),
  taxDbp: z.number().int().optional().describe("The invoice's tax rate in thousandths of a percent: 7000 = 7%, 6625 = 6.625% (ADR 0173)"),
  taxRounding: z.enum(['half_up', 'half_even']).optional().describe("How the invoice's tax is rounded (ADR 0173)"),
  items: z.array(
    z.object({
      name: z.string(),
      priceCents: z.number().int().describe('What the line charges'),
      kind: z.enum(['package', 'addon']),
      listCents: z.number().int().nullable().optional().describe('The regular price at the size; null on a line priced before sizes'),
      discountBp: z.number().int().nullable().optional().describe('The member % off applied, in basis points'),
      memberDiscountCents: z.number().int().optional().describe('list - price'),
      classLabel: z.string().nullable().optional().describe('The size the line is priced at'),
    }),
  ),
  payMethodLabel: z.string().nullable(),
  vehicleClassLabel: z.string().nullable().optional().describe('The size the invoice is priced at ("Large SUV")'),
  coverage: z
    .array(
      z.object({
        serviceName: z.string(),
        coveredCents: z.number().int(),
        lineCents: z.number().int(),
        differenceCents: z.number().int().describe('line - covered: the size difference that stays due'),
        planClassLabel: z.string().nullable().describe('The size the membership is priced at'),
      }),
    )
    .optional()
    .describe('What the membership covered: "Covered $40 · $20 size difference due"'),
  refundedCents: z.number().int().optional().describe('Refunds done (a failed card refund and one waiting for approval are not counted)'),
  processing: InvoiceProcessing.optional().describe(
    'Who takes card money and which Square tenders the Collect sheet may offer, for every role (no pay.reports needed)',
  ),
  deposit: DepositView.nullable().optional().describe('The visit’s deposit: asked for by link, paid, kept, refunded, or a refund waiting for approval; null without one'),
})

/** appointments.categories (ADR 0160, plan K): the category keys of the package and live add-ons, in category order. */
export const Categories = z
  .array(z.string())
  .describe('The category keys the visit holds (package and live add-ons), in the categories’ order: the chips')
export const VisitCategory = z
  .string()
  .nullable()
  .describe('The one word the visit counts under (KPIs, Payments split): its category ignoring add-ons, "mixed" for two or more, the add-ons category for add-ons alone, null for none')

/** The size of a visit (ADR 0170, wave Q2). */
export const SizeFields = {
  vehicleClass: z.string().nullable().describe('The vehicle size the visit is priced at (a size key); null when nobody knew it'),
  vehicleClassLabel: z.string().nullable().describe('"Large SUV"'),
  needsSizeConfirm: z
    .boolean()
    .describe('No size known: priced at the smallest size (the starting price) until staff confirm the size at the shop ("Confirm size")'),
  needsPriceConfirm: z
    .boolean()
    .describe(
      'A line (the package or a live add-on) was charged a price the owner has not set for the size: the starting price (the size has no price of its own) or the service’s one price (no prices by size, not a quote): "Confirm price" until staff confirm the size',
    ),
}

export const PriceBasis = z
  .enum(['legacy', 'class', 'unknown_class', 'estimated', 'base'])
  .describe(
    "How a price was found: class (the size's own price), unknown_class (no size known: the smallest size's), estimated (the size has no price: the starting price), base (the service has no prices by size), legacy (priced before sizes)",
  )

export const QuoteTotals = z.object({
  listCents: z.number().int().describe('Sum of the regular prices at the size'),
  discountCents: z.number().int().describe('Sum of the member % off'),
  coveredCents: z.number().int().describe('What the membership would cover (applied when the visit is completed)'),
  dueCents: z.number().int().describe('What the client owes before tax and tip'),
})

export const PricingView = z
  .object({
    vehicleClass: z.string().nullable(),
    vehicleClassLabel: z.string().nullable(),
    basis: PriceBasis,
    needsSizeConfirm: z.boolean(),
    needsPriceConfirm: z.boolean(),
    member: z.boolean().describe('Priced as a member (the holder or a household member of an active membership)'),
    confirmAtShop: z
      .boolean()
      .describe('A price depends on a size not known yet, or the size has no price of its own: the exact price is confirmed at the shop'),
    totals: QuoteTotals,
  })
  .describe('What the visit was priced at (ADR 0170)')

export const QuoteResult = z.object({
  pricing: PricingView,
  member: z
    .object({
      tierName: z.string(),
      planClass: z.string(),
      planClassLabel: z.string().nullable(),
      discountBp: z.number().int(),
      household: z.boolean().describe('The client shares the membership as a household member'),
    })
    .nullable(),
  lines: z.array(
    z.object({
      serviceId: z.string(),
      name: z.string(),
      kind: z.enum(['package', 'addon']),
      listCents: z.number().int(),
      listMaxCents: z.number().int().nullable().describe('The top of a range (tint)'),
      chargeCents: z.number().int().describe('What the line would charge'),
      memberDiscountCents: z.number().int(),
      discountBp: z.number().int(),
      basis: PriceBasis,
      coverage: z
        .object({
          label: z.string(),
          coveredCents: z.number().int(),
          differenceCents: z.number().int(),
          planClassLabel: z.string().nullable(),
        })
        .nullable(),
      dueCents: z.number().int(),
    }),
  ),
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
  member: z
    .object({
      plan: z.string(),
      label: z.string(),
      color: z.string().optional().describe('The tier’s badge colour (#RRGGBB), as the file’s membership'),
      bgColor: z.string().optional().describe('The tier’s badge background'),
    })
    .nullable(),
  vehicle: Vehicle.nullable(),
  vehicleLine: z.string(),
  vehicleShort: z.string(),
  service: z.string(),
  categories: Categories,
  category: VisitCategory,
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
  ...SizeFields,
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

/** The per-category counts of the KPI strip (ADR 0160, plan K). */
export const CategoryCounts = z
  .object({
    bizDate: BizDate,
    total: z.number().int().describe('Today’s jobs that are not canceled or no-show'),
    items: z.array(
      z.object({
        key: z.string().describe('A category key, "mixed" (two or more categories other than add-ons), or "_none" (no category)'),
        label: z.string(),
        colour: z.string().nullable().describe('#RRGGBB of the category; null for "mixed", "_none" and an unknown key'),
        count: z.number().int(),
      }),
    ),
  })
  .describe('Today’s visits by category, each counted once: every active category (zero included) in the categories’ order, then "mixed"; an inactive category and "_none" only when something counts under them. Search and window never affect it.')

export const OpsSnapshot = z.object({
  now: z.object({ iso: Instant, tz: z.string(), bizDate: BizDate, time: z.string(), dateLabel: z.string() }),
  window: z.enum(['next24', 'today', 'tomorrow', 'week']),
  q: z.string(),
  kpis: z.array(Kpi),
  categoryCounts: CategoryCounts,
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
  categories: Categories,
  category: VisitCategory,
  ...SizeFields,
})

export const Toast = z.object({ title: z.string(), detail: z.string() })

export const DepositChoice = z.enum(['policy', 'keep', 'refund_card', 'refund_credit'])

export const Settlement = z.object({
  policy: DepositChoice,
  heldCents: z
    .number()
    .int()
    .describe('Money held on the invoice when it was canceled (payments less refunds), in cents'),
  refundedCents: z
    .number()
    .int()
    .describe('Refunds that are done; a refund waiting for approval is not counted'),
  retainedCents: z.number().int().describe('The share of the held money that stays with the shop'),
  refunds: z.array(
    z.object({
      amountCents: z.number().int(),
      dest: z.enum(['card', 'cash', 'credit']),
      state: z.enum(['done', 'pending']),
      awaitingProcessor: z.boolean().describe('A card refund that must still be completed in Squarespace'),
    }),
  ),
  rule: z.string().describe('Why: the lead time against the free-cancellation window, or the staff choice'),
  cardFee: z
    .object({
      chargeId: z.string(),
      purpose: z.enum(['no_show_fee', 'late_cancel_fee']),
      amountCents: z.number().int(),
      cardLabel: z.string().describe('"Visa ••4242"'),
    })
    .nullable()
    .optional()
    .describe('A no-show or late-cancel fee beyond the deposit kept, PROPOSED on the client’s saved card (ADR 0171 D7): charge or waive it (POST /appointments/:id/fee-charges/:chargeId/charge | waive). Only with fees.card_on_file on and Square the processor.'),
})

export const CommandResult = z.object({
  appointment: AppointmentCore,
  toast: Toast,
  warnings: z.array(z.string()),
  invoice: InvoiceSummary.nullable().optional(),
  depositPolicy: DepositChoice.optional(),
  settlement: Settlement.nullable().optional(),
})

export const BookingResult = z.object({
  appointment: AppointmentCore,
  customer: z.object({ id: z.string(), name: z.string(), created: z.boolean() }),
  invoice: InvoiceSummary,
  overrides: z.array(z.object({ kind: z.string(), reason: z.string() })),
  messageQueued: z.boolean(),
  toast: Toast,
  pricing: PricingView,
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
  categories: Categories,
  category: VisitCategory,
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
  vehicle: Vehicle.extend({
    id: z.string(),
    vehicleClass: z.string().nullable().describe('The car’s size on file (ADR 0170)'),
    vehicleClassSource: z.enum(['staff', 'client', 'ai', 'legacy']).nullable().describe('Who said the size'),
  }).nullable(),
  ...SizeFields,
  priceBasis: PriceBasis,
  classConfirmedAt: z.string().nullable().describe('When staff confirmed the size at the shop'),
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
      planKey: z.string().optional().describe('The tier’s key (gold, vip, …; ADR 0170)'),
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
  membershipUpgrade: z
    .object({
      candidate: z.boolean(),
      visits60: z.number().int().describe('Completed visits in the last 60 days (real history)'),
      copy: z.string().nullable(),
    })
    .nullable()
    .describe('For a client without a live membership: whether to offer one. null for members.'),
  history: z.object({
    visitCount: z.number().int(),
    recent: z.array(
      z.object({
        id: z.string(),
        bizDate: BizDate,
        service: z.string(),
        status: z.string(),
        priceCents: z.number().int(),
        categories: Categories,
        category: VisitCategory,
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
  categories: Categories.describe('The appointment’s categories after the change (a tint add-on makes a wash "mixed")'),
  category: VisitCategory,
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
