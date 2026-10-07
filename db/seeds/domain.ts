// Seed profiles for the domain core and the Settings data, from the Settings and Operations designs.
//   domain         the location's reference data: two bays, hours, rules, the seven design closures (the 2026 federal run
//                  pre-marked), emergency history, VIP settings and holds, arrival settings, the 9 packages and 10 add-ons
//                  with their checklists (the /inspection/i tasks dropped here, at seed time).
//   domain-design  the design's customers and vehicles (synthetic 555-01xx numbers) and the VIP client list.
//   base, design   compositions the other seed files extend through dependsOn.
// Everything is idempotent: natural keys with "do nothing" semantics, never an update, so a second run changes nothing.
// Appointments and invoices are seeded by the verticals that own them.
import { sql } from 'kysely'
import { formatPhoneDisplay } from '../../src/platform/phone.js'
import { wallToInstant } from '../../src/platform/time.js'
import { ensureDomainDefaults } from '../../src/modules/settings/defaults.js'
import { emergencySummary } from '../../src/modules/settings/emergency.js'
import type { FederalHolidayKey } from '../../src/modules/settings/federal-holidays.js'
import type { ClosureType, EmergencyReason } from '../../src/modules/settings/schema.js'
import '../../src/modules/catalog/schema.js'
import '../../src/modules/customers/schema.js'
import '../../src/modules/settings/schema.js'
import type { SeedContext, SeedProfile } from './index.js'

// Catalog ---------------------------------------------------------------------------------------------------------

export interface SeedPackage {
  name: string
  priceDollars: number
  durationMin: number
  tags: string[]
  /** The tasks as the design's source lists them, including the ones its boot code filters out. */
  rawTasks: string[]
}

export interface SeedAddon {
  name: string
  priceDollars: number
  tasks: string[]
}

/** The design removes every task matching this at load; the seed applies the same rule to the real data (B49). */
export const INSPECTION_TASK = /inspection/i

export const DESIGN_PACKAGES: readonly SeedPackage[] = [
  {
    name: 'Express Hand Wash',
    priceDollars: 45,
    durationMin: 35,
    tags: ['express', 'handwash'],
    rawTasks: ['Exterior rinse', 'Hand wash', 'Wheel cleaning', 'Hand dry & towel', 'Glass & windows'],
  },
  {
    name: 'Premium Hand Wash + Interior',
    priceDollars: 129,
    durationMin: 75,
    tags: ['premium', 'handwash'],
    rawTasks: [
      'Exterior pre-rinse',
      'Two-bucket hand wash',
      'Wheel & tire cleaning',
      'Tire shine',
      'Interior vacuum',
      'Dashboard & console wipe',
      'Streak-free windows',
      'Final inspection',
    ],
  },
  {
    name: 'Premium Hand Wash + Interior Refresh',
    priceDollars: 139,
    durationMin: 75,
    tags: ['premium', 'handwash'],
    rawTasks: [
      'Exterior pre-rinse',
      'Two-bucket hand wash',
      'Wheel & tire cleaning',
      'Tire shine',
      'Interior vacuum',
      'Dashboard & vents wipe',
      'Leather seat refresh',
      'Streak-free windows',
      'Final inspection',
    ],
  },
  {
    name: 'Executive Detail',
    priceDollars: 260,
    durationMin: 90,
    tags: ['executive'],
    rawTasks: [
      'Foam pre-soak',
      'Two-bucket hand wash',
      'Clay bar treatment',
      'Wheel & caliper detail',
      'Tire dressing',
      'Full interior vacuum',
      'Leather conditioning',
      'Dashboard & vents detail',
      'Streak-free glass',
      'Spray sealant',
      'Final inspection',
    ],
  },
  {
    name: 'Executive Detail + Ceramic',
    priceDollars: 420,
    durationMin: 120,
    tags: ['executive', 'ceramic'],
    rawTasks: [
      'Foam pre-soak',
      'Two-bucket hand wash',
      'Iron decontamination',
      'Clay bar treatment',
      'Ceramic spray coat',
      'Wheel & caliper detail',
      'Full interior detail',
      'Leather conditioning',
      'Streak-free glass',
      'Final inspection',
    ],
  },
  {
    name: 'Full Detail',
    priceDollars: 320,
    durationMin: 120,
    tags: ['detail'],
    rawTasks: [
      'Engine bay degrease',
      'Foam pre-soak',
      'Hand wash',
      'Clay bar',
      'Wheel deep clean',
      'Carpet shampoo',
      'Full interior vacuum',
      'Leather treatment',
      'Glass polish',
      'Wax & seal',
      'Final inspection',
    ],
  },
  {
    name: 'Ceramic Maintenance + Wax',
    priceDollars: 180,
    durationMin: 60,
    tags: ['ceramic'],
    rawTasks: [
      'Pre-rinse',
      'pH-neutral hand wash',
      'Ceramic boost spray',
      'Hand-applied wax',
      'Wheel cleaning',
      'Tire dressing',
      'Glass treatment',
      'Final inspection',
    ],
  },
  {
    name: 'Exotic Detail Package',
    priceDollars: 650,
    durationMin: 150,
    tags: ['exotic'],
    rawTasks: [
      'Hand-dry pre-inspection',
      'Waterless decon',
      'Two-bucket hand wash',
      'Paint correction pass',
      'Ceramic seal',
      'Wheel & caliper detail',
      'Full interior detail',
      'Leather conditioning',
      'Glass & trim restore',
      'Photographic handover',
      'Final inspection',
    ],
  },
  {
    name: 'Family Wash + Pet Hair',
    priceDollars: 95,
    durationMin: 50,
    tags: ['handwash', 'family'],
    rawTasks: [
      'Exterior rinse',
      'Hand wash',
      'Pet hair removal',
      'Interior vacuum',
      'Dashboard wipe',
      'Windows',
      'Odor neutralize',
      'Final inspection',
    ],
  },
]

export const DESIGN_ADDONS: readonly SeedAddon[] = [
  {
    name: 'Interior deep clean',
    priceDollars: 60,
    tasks: ['Deep vacuum seats & carpets', 'Steam clean vents & cupholders', 'Wipe door jambs & panels'],
  },
  {
    name: 'Pet hair removal',
    priceDollars: 35,
    tasks: ['Rubber-brush pet hair', 'Lint-roll upholstery', 'Vacuum seat seams'],
  },
  {
    name: 'Leather conditioning',
    priceDollars: 45,
    tasks: ['Clean leather surfaces', 'Apply conditioner', 'Buff to matte finish'],
  },
  { name: 'Wax', priceDollars: 40, tasks: ['Apply carnauba wax', 'Buff off haze'] },
  { name: 'Clay bar', priceDollars: 50, tasks: ['Lubricate panels', 'Clay bar paint', 'Wipe residue'] },
  {
    name: 'Odor removal',
    priceDollars: 30,
    tasks: ['Enzyme treatment on fabrics', 'Odor neutralizer cycle'],
  },
  {
    name: 'Engine bay cleaning',
    priceDollars: 55,
    tasks: ['Cover electricals', 'Degrease engine bay', 'Dress plastics'],
  },
  { name: 'Ceramic maintenance', priceDollars: 120, tasks: ['Ceramic boost spray', 'Buff & level coating'] },
  {
    name: 'Rain repellent',
    priceDollars: 25,
    tasks: ['Clean glass', 'Apply rain repellent to windshield'],
  },
  {
    name: 'Wheel deep clean',
    priceDollars: 40,
    tasks: ['Remove wheel fallout', 'Clean barrels & calipers', 'Seal wheel faces'],
  },
]

/** A package's tasks after the design's own filter. */
export const seedTasks = (p: SeedPackage): string[] => p.rawTasks.filter((t) => !INSPECTION_TASK.test(t))

// Closures and emergency history ------------------------------------------------------------------------------------------

export interface SeedClosure {
  date: string
  name: string
  type: ClosureType
  openMin?: number
  closeMin?: number
  source: 'manual' | 'federal' | 'emergency'
  federalKey?: FederalHolidayKey
}

export const DESIGN_CLOSURES: readonly SeedClosure[] = [
  { date: '2026-05-25', name: 'Memorial Day', type: 'closed', source: 'federal', federalKey: 'memorial_day' },
  { date: '2026-06-03', name: 'Weather closure', type: 'closed', source: 'emergency' },
  {
    date: '2026-07-04',
    name: 'Independence Day',
    type: 'closed',
    source: 'federal',
    federalKey: 'independence_day',
  },
  {
    date: '2026-09-07',
    name: 'Labor Day',
    type: 'reduced',
    openMin: 600,
    closeMin: 840,
    source: 'federal',
    federalKey: 'labor_day',
  },
  { date: '2026-11-26', name: 'Thanksgiving', type: 'closed', source: 'federal', federalKey: 'thanksgiving' },
  {
    date: '2026-12-24',
    name: 'Christmas Eve',
    type: 'reduced',
    openMin: 480,
    closeMin: 780,
    source: 'manual',
  },
  { date: '2026-12-25', name: 'Christmas Day', type: 'closed', source: 'federal', federalKey: 'christmas' },
]

export interface SeedEmergency {
  date: string
  reason: EmergencyReason
  kind: 'today' | 'until'
  /** Wall-clock minutes the closure began (until) and ended. */
  startMin: number
  endMin: number
  untilMin?: number
  pause: boolean
  affected: number
  notified: number
  rebooked: number
  detail: string
}

/** Newest first, as the history list shows them. */
export const DESIGN_EMERGENCIES: readonly SeedEmergency[] = [
  {
    date: '2026-06-03',
    reason: 'severe_weather',
    kind: 'today',
    startMin: 450,
    endMin: 1080,
    pause: true,
    affected: 7,
    notified: 7,
    rebooked: 6,
    detail: 'Full day · 7 customers notified · 6 rebooked',
  },
  {
    date: '2026-02-18',
    reason: 'power_outage',
    kind: 'until',
    startMin: 680,
    endMin: 900,
    untilMin: 900,
    pause: false,
    affected: 4,
    notified: 4,
    rebooked: 0,
    detail: '11:20 AM – 3:00 PM · 4 notified',
  },
]

/** Saturday 8/9/10 AM, Friday 4 PM, Sunday 9 AM. */
export const DESIGN_VIP_HOLDS: readonly { weekday: number; timeMin: number }[] = [
  { weekday: 6, timeMin: 480 },
  { weekday: 6, timeMin: 540 },
  { weekday: 6, timeMin: 600 },
  { weekday: 5, timeMin: 960 },
  { weekday: 0, timeMin: 540 },
]

// Customers ----------------------------------------------------------------------------------------------------------------

export interface SeedCustomer {
  /** The design appointment this person belongs to (a1..a12). */
  ref: string
  name: string
  /** E.164, always +1 AAA 555 01xx (reserved for fiction). */
  phoneE164: string
  vehicle: { year: number; make: string; model: string; color: string; plate: string }
}

const fiction = (area: string, line: string): string => `+1${area}555${line}`

export const DESIGN_CUSTOMERS: readonly SeedCustomer[] = [
  {
    ref: 'a1',
    name: 'Maria Delgado',
    phoneE164: fiction('305', '0102'),
    vehicle: { year: 2021, make: 'Audi', model: 'Q5', color: 'Pearl White', plate: 'KLP-8842' },
  },
  {
    ref: 'a2',
    name: 'David Okafor',
    phoneE164: fiction('786', '0103'),
    vehicle: { year: 2019, make: 'Ford', model: 'F-150', color: 'Magnetic Gray', plate: 'FRD-1190' },
  },
  {
    ref: 'a3',
    name: 'Priya Nair',
    phoneE164: fiction('305', '0104'),
    vehicle: { year: 2022, make: 'Tesla', model: 'Model Y', color: 'Midnight Silver', plate: 'TES-2210' },
  },
  {
    ref: 'a4',
    name: 'Jonathan Franco',
    phoneE164: fiction('305', '0105'),
    vehicle: { year: 2023, make: 'Mercedes-Benz', model: 'GLE', color: 'Obsidian Black', plate: 'ABC-1234' },
  },
  {
    ref: 'a5',
    name: 'Sofia Marchetti',
    phoneE164: fiction('786', '0106'),
    vehicle: { year: 2024, make: 'Porsche', model: 'Macan', color: 'Carmine Red', plate: 'POR-9911' },
  },
  {
    ref: 'a6',
    name: 'Liam Chen',
    phoneE164: fiction('305', '0107'),
    vehicle: { year: 2020, make: 'BMW', model: 'M340i', color: 'Alpine White', plate: 'BMW-3401' },
  },
  {
    ref: 'a7',
    name: 'Marcus Webb',
    phoneE164: fiction('786', '0108'),
    vehicle: { year: 2017, make: 'Jeep', model: 'Wrangler', color: 'Sarge Green', plate: 'JEP-7720' },
  },
  {
    ref: 'a8',
    name: 'Grace Adeyemi',
    phoneE164: fiction('305', '0109'),
    vehicle: { year: 2018, make: 'Lexus', model: 'RX 350', color: 'Silver Lining', plate: 'LEX-0455' },
  },
  {
    ref: 'a9',
    name: 'Aisha Rahman',
    phoneE164: fiction('786', '0110'),
    vehicle: { year: 2023, make: 'Range Rover', model: 'Sport', color: 'Santorini Black', plate: 'RR-5567' },
  },
  {
    ref: 'a10',
    name: 'Tom Bradley',
    phoneE164: fiction('305', '0111'),
    vehicle: { year: 2016, make: 'Honda', model: 'Civic', color: 'Aegean Blue', plate: 'HND-2218' },
  },
  {
    ref: 'a11',
    name: 'Elena Volkov',
    phoneE164: fiction('786', '0112'),
    vehicle: { year: 2022, make: 'Lamborghini', model: 'Urus', color: 'Giallo Inti', plate: 'URS-0001' },
  },
  {
    ref: 'a12',
    name: 'Nathan Brooks',
    phoneE164: fiction('305', '0113'),
    vehicle: { year: 2021, make: 'Chevrolet', model: 'Tahoe', color: 'Summit White', plate: 'CHV-6610' },
  },
]

/** The Settings design's VIP list (names, resolved to customers by exact name). */
export const DESIGN_VIP_NAMES: readonly string[] = [
  'Jonathan Franco',
  'Liam Chen',
  'Aisha Rahman',
  'Elena Volkov',
]

// Runners ------------------------------------------------------------------------------------------------------------------

async function seedBays(ctx: SeedContext): Promise<void> {
  await ctx.tx
    .insertInto('bays')
    .values(
      [1, 2].map((n) => ({
        id: ctx.newId(),
        location_id: ctx.location.id,
        number: n,
        name: `Bay ${n}`,
        sort: n,
      })),
    )
    .onConflict((oc) => oc.columns(['location_id', 'number']).doNothing())
    .execute()
}

async function seedCatalog(ctx: SeedContext): Promise<void> {
  const { tx, location } = ctx
  const insertService = async (
    kind: 'package' | 'addon',
    name: string,
    priceDollars: number,
    durationMin: number,
    tags: string[],
    sort: number,
    bookableDesk: boolean,
    tasks: string[],
  ): Promise<void> => {
    const existing = await tx
      .selectFrom('services')
      .select('id')
      .where('location_id', '=', location.id)
      .where('kind', '=', kind)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .executeTakeFirst()
    const id = existing?.id ?? ctx.newId()
    if (!existing) {
      await tx
        .insertInto('services')
        .values({
          id,
          location_id: location.id,
          kind,
          name,
          short_name: null,
          price_cents: priceDollars * 100,
          duration_min: durationMin,
          tags,
          bookable_desk: bookableDesk,
          sort,
          active: true,
          sqsp_sku: null,
        })
        .execute()
    }
    // Tasks are only ever created with the service or onto an empty checklist; edits and retirements are never undone.
    const hasTasks = await tx
      .selectFrom('checklist_tasks')
      .select('id')
      .where('service_id', '=', id)
      .limit(1)
      .executeTakeFirst()
    if (!hasTasks && tasks.length > 0) {
      await tx
        .insertInto('checklist_tasks')
        .values(
          tasks.map((label, position) => ({
            id: ctx.newId(),
            service_id: id,
            label,
            position,
            retired_at: null,
          })),
        )
        .execute()
    }
  }
  let i = 0
  for (const p of DESIGN_PACKAGES) {
    // The new-appointment picker offers only the first five packages (Object.keys(services).slice(0, 5)).
    await insertService(
      'package',
      p.name,
      p.priceDollars,
      p.durationMin,
      p.tags,
      (i + 1) * 10,
      i < 5,
      seedTasks(p),
    )
    i += 1
  }
  i = 0
  for (const a of DESIGN_ADDONS) {
    await insertService('addon', a.name, a.priceDollars, 0, [], (i + 1) * 10, true, a.tasks)
    i += 1
  }
}

async function seedClosures(ctx: SeedContext): Promise<void> {
  const { tx, location } = ctx
  const tz = location.timezone
  // History first: the Jun 3 closure row points at its emergency.
  const emergencyIds = new Map<string, string>()
  for (const e of DESIGN_EMERGENCIES) {
    const startedAt = wallToInstant(e.date, e.startMin, tz)
    const existing = await tx
      .selectFrom('emergency_closures')
      .select('id')
      .where('location_id', '=', location.id)
      .where('started_at', '=', startedAt)
      .executeTakeFirst()
    const id = existing?.id ?? ctx.newId()
    emergencyIds.set(e.date, id)
    if (existing) continue
    const duration =
      e.kind === 'today' ? { kind: 'today' as const } : { kind: 'until' as const, untilMin: e.untilMin }
    await tx
      .insertInto('emergency_closures')
      .values({
        id,
        location_id: location.id,
        active: false,
        reason: e.reason,
        duration_kind: e.kind,
        until_min: e.untilMin ?? null,
        through_date: e.date,
        ends_at: wallToInstant(e.date, e.endMin, tz),
        message: '',
        notify: true,
        link: true,
        credits: true,
        pause: e.pause,
        crew: true,
        summary: emergencySummary(e.reason, duration, e.pause),
        started_at: startedAt,
        started_by: null,
        started_by_name: null,
        reopened_at: wallToInstant(e.date, e.endMin, tz),
        reopened_by: null,
        reopened_by_name: null,
        auto_reopened: true,
        affected_count: e.affected,
        notified_count: e.notified,
        rebooked_count: e.rebooked,
        detail: e.detail,
      })
      .execute()
  }
  for (const c of DESIGN_CLOSURES) {
    // A closure that was removed after seeding stays removed: match on date and name whether or not it is deleted.
    const seen = await tx
      .selectFrom('closures')
      .select('id')
      .where('location_id', '=', location.id)
      .where('date', '=', c.date)
      .where('name', '=', c.name)
      .executeTakeFirst()
    if (seen) continue
    await tx
      .insertInto('closures')
      .values({
        id: ctx.newId(),
        location_id: location.id,
        date: c.date,
        name: c.name,
        type: c.type,
        open_min: c.type === 'reduced' ? c.openMin! : null,
        close_min: c.type === 'reduced' ? c.closeMin! : null,
        notify: true,
        source: c.source,
        federal_key: c.federalKey ?? null,
        federal_year: c.federalKey ? Number(c.date.slice(0, 4)) : null,
        emergency_closure_id: c.source === 'emergency' ? emergencyIds.get(c.date)! : null,
        created_by: null,
        deleted_at: null,
      })
      .onConflict((oc) => oc.columns(['location_id', 'date']).where('deleted_at', 'is', null).doNothing())
      .execute()
  }
  // The 2026 run is recorded as done, so only the design's closures exist for the year.
  await tx
    .insertInto('federal_holiday_runs')
    .values({ location_id: location.id, year: 2026 })
    .onConflict((oc) => oc.columns(['location_id', 'year']).doNothing())
    .execute()
}

async function seedVip(ctx: SeedContext): Promise<void> {
  await ctx.tx
    .insertInto('vip_holds')
    .values(
      DESIGN_VIP_HOLDS.map((h) => ({
        id: ctx.newId(),
        location_id: ctx.location.id,
        weekday: h.weekday,
        time_min: h.timeMin,
      })),
    )
    .onConflict((oc) => oc.columns(['location_id', 'weekday', 'time_min']).doNothing())
    .execute()
}

export async function seedDomainReference(ctx: SeedContext): Promise<void> {
  await ensureDomainDefaults(ctx.tx, ctx.location.id)
  await seedBays(ctx)
  await seedCatalog(ctx)
  await seedClosures(ctx)
  await seedVip(ctx)
  ctx.log('domain: bays, hours, rules, closures, emergency history, catalog, VIP and arrival settings')
}

export async function seedDomainDesign(ctx: SeedContext): Promise<void> {
  const { tx, location } = ctx
  const optedInAt = ctx.clock.now()
  const customerIds = new Map<string, string>()
  for (const c of DESIGN_CUSTOMERS) {
    const existing = await tx
      .selectFrom('customers')
      .select('id')
      .where('phone_e164', '=', c.phoneE164)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    const id = existing?.id ?? ctx.newId()
    customerIds.set(c.name, id)
    if (!existing) {
      await tx
        .insertInto('customers')
        .values({
          id,
          full_name: c.name,
          phone_e164: c.phoneE164,
          phone_display: formatPhoneDisplay(c.phoneE164),
          email: null,
          notes: null,
          sms_opted_in: true,
          sms_opt_in_source: 'import',
          sms_opt_in_at: optedInAt,
          source: 'import',
          synthetic: true,
        })
        .execute()
    }
    await tx
      .insertInto('vehicles')
      .values({ id: ctx.newId(), customer_id: id, ...c.vehicle, deleted_at: null })
      .onConflict((oc) => oc.expression(sql`customer_id, upper(plate)`).doNothing())
      .execute()
  }
  for (const name of DESIGN_VIP_NAMES) {
    await tx
      .insertInto('vip_clients')
      .values({ location_id: location.id, customer_id: customerIds.get(name)! })
      .onConflict((oc) => oc.columns(['location_id', 'customer_id']).doNothing())
      .execute()
  }
  ctx.log('domain-design: customers, vehicles, VIP clients')
}

const domain: SeedProfile = {
  description:
    'Domain reference data: bays, hours, rules, closures, emergency history, catalog, VIP and arrival settings',
  run: seedDomainReference,
}

const domainDesign: SeedProfile = {
  description: 'Design customers and vehicles (synthetic 555-01xx numbers) and the VIP client list',
  dependsOn: ['domain'],
  run: seedDomainDesign,
}

/** Registered by db/seeds/index.ts. The base and design profiles are compositions other seed files extend via dependsOn. */
export const domainSeedProfiles: Record<string, SeedProfile> = {
  domain,
  'domain-design': domainDesign,
  base: {
    description:
      'Reference data every environment needs: roles and employees (people) plus the domain reference data',
    dependsOn: ['people', 'domain'],
    run: async () => undefined,
  },
  design: {
    description: 'Base plus the design fixtures',
    dependsOn: ['base', 'domain-design'],
    run: async () => undefined,
  },
}
