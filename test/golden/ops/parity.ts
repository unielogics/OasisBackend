// The parity-ops world for the oracle tests: the seeded design day, invoices for the 12 design appointments through the
// in-memory gateway (cent-level, from PARITY_OPS_MONEY), and the design's membership plans through the in-memory port.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { runSeed } from '../../../db/seeds/index.js'
import { DESIGN_APPOINTMENTS, PARITY_OPS_MEMBERS, PARITY_OPS_MONEY } from '../../../db/seeds/scheduling.js'
import { FixedClock, PARITY_NOW } from '../../../src/platform/clock.js'
import { transaction } from '../../../src/platform/db.js'
import { createIdGenerator } from '../../../src/platform/ids.js'
import type { SchedulingCtx } from '../../../src/modules/scheduling/context.js'
import {
  InMemoryInvoiceGateway,
  InMemoryMemberships,
  InMemoryMessageQueue,
  noExternalAlerts,
} from '../../../src/modules/scheduling/ports.js'
import { FsStorage } from '../../../src/integrations/storage/fs-provider.js'
import { createTestDb, truncateAll, type TestDb } from '../../helpers/db.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

export interface Original {
  initial: Board
  ranges: Record<'today' | 'tomorrow' | 'week' | 'next24', Board>
  slots: { label: string; opacity: number; cursor: string }[]
  appointments: OriginalAppointment[]
  dayCounts: {
    offset: number
    iso: string
    count: number
    closed: string | null
    note: string
    h0: number | null
    h1: number | null
  }[]
  calendar: Record<string, CalendarShot>
}

export interface Card {
  id: string
  name: string
  vip: boolean
  member: string
  vehicleLine: string
  service: string
  time: string
  badgeLabel: string
  bayLabel: string
  durLabel: string
  payLabel: string
  nextLabel: string
  hasNotes: boolean
  hasPhotos: boolean
  hasAddons: boolean
  addonCount: number
}

export interface Board {
  apptCount: number
  inFacilityLabel: string
  kpis: { label: string; value: string; sub: string }[]
  alerts: { glyph: string; title: string; desc: string; actionLabel: string; pri: number }[]
  groups: { dividerLabel: string; time: string; ampm: string; items: Card[] }[]
  queue: Card[]
  completed: {
    id: string
    name: string
    time: string
    vehicleLine: string
    service: string
    payChipLabel: string
    pickupChipLabel: string
  }[]
  completedCount: number
  bays: Record<string, unknown>[]
  arrivals: { title: string; desc: string; prepLabel: string }[]
  staffCols: {
    name: string
    role: string
    initials: string
    count: number
    jobs: { id: string; name: string; time: string }[]
  }[]
}

export interface OriginalAppointment {
  id: string
  day: number
  time: string
  status: string
  svc: string
  staff: string
  bay: number | null
  vip: boolean
  member: string | null
  photos: { arrival: number; before: number; after: number; issue: number }
  visits: number
  notes: string
  special: string | null
  pay: string
  deposit: number
  tip: number
  addons: string[]
  sub: number
  tax: number
  grand: number
  balance: number
  checkDone: number
  checkTotal: number
  checkPct: string
  sections: { title: string; kind: string; countLabel: string }[]
}

export interface CalendarShot {
  calLabel: string
  calSub: string
  calClosed: boolean
  calClosedReason: string
  calWeek: {
    dow: string
    num: string
    count: string
    countLabel: string
    closed: boolean
    reason: string
    isToday: boolean
  }[]
  calMonth: { num: string; showCount: boolean; countLabel: string; closed: boolean; reason: string }[]
  calRows: { time: string; ampm: string; empty: boolean; items: { name: string; badgeLabel: string }[] }[]
}

export const original: Original = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'original.json'), 'utf8'),
)

export interface ParityWorld {
  readonly t: TestDb
  readonly ctx: SchedulingCtx
  readonly gateway: InMemoryInvoiceGateway
  readonly memberships: InMemoryMemberships
  readonly queue: InMemoryMessageQueue
  /** design id (a1..a12) to appointment uuid */
  readonly ids: Map<string, string>
  readonly locationId: string
}

export function useParityOps(): ParityWorld {
  let t: TestDb
  let ctx: SchedulingCtx
  let locationId = ''
  const ids = new Map<string, string>()
  const gateway = new InMemoryInvoiceGateway()
  const memberships = new InMemoryMemberships()
  const queue = new InMemoryMessageQueue()

  beforeAll(async () => {
    const clock = new FixedClock(PARITY_NOW)
    t = await createTestDb({ clock, poolMax: 6 })
    await truncateAll(t.db)
    await runSeed({ db: t.db, clock, profile: 'parity-ops' })
    locationId = (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
    const storage = new FsStorage({
      root: mkdtempSync(path.join(tmpdir(), 'oasis-parity-')),
      clock,
      secret: 'test-storage-secret-0123456789',
      baseUrl: 'http://localhost:4000/dev-storage',
    })
    ctx = {
      clock,
      newId: createIdGenerator(clock),
      locationId,
      tz: 'America/New_York',
      ports: { invoices: gateway, messages: queue, memberships, externalAlerts: noExternalAlerts, storage },
    }
    const customers = new Map(
      (await t.db.selectFrom('customers').select(['id', 'full_name']).execute()).map((c) => [
        c.full_name,
        c.id,
      ]),
    )
    for (const [name, plan] of Object.entries(PARITY_OPS_MEMBERS))
      memberships.byCustomer.set(customers.get(name)!, {
        plan,
        creditsLeft: plan === 'Executive' || plan === 'Exotic' ? null : 1,
        creditAvailable: plan.startsWith('Premium'),
      })
    // appointments in design order, found by customer and start
    for (const a of DESIGN_APPOINTMENTS) {
      const row = await t.db
        .selectFrom('appointments')
        .select(['id', 'package_name', 'price_cents'])
        .where('customer_id', '=', customers.get(a.customer)!)
        .where('package_name', '=', a.svc)
        .where('scheduled_start', '>=', new Date('2026-06-13T04:00:00Z'))
        .where('scheduled_start', '<', new Date('2026-06-15T04:00:00Z'))
        .executeTakeFirstOrThrow()
      ids.set(a.id, row.id)
      const addons = await t.db
        .selectFrom('appointment_addons')
        .select(['name', 'price_cents'])
        .where('appointment_id', '=', row.id)
        .execute()
      await transaction(t.db, async (tx) => {
        await gateway.ensureForAppointment(tx, {
          appointmentId: row.id,
          locationId,
          customerId: customers.get(a.customer)!,
          clientName: a.customer,
          vehicleLabel: 'Vehicle',
          staffLabel: a.staff,
          occurredAt: new Date(),
          packageName: row.package_name,
          packagePriceCents: row.price_cents,
          addons: addons.map((x) => ({ name: x.name, priceCents: x.price_cents })),
        })
      })
      const money = PARITY_OPS_MONEY[a.id]!
      if (money.tipCents) gateway.setTip(row.id, money.tipCents)
      if (money.pay === 'paid') gateway.payInFull(row.id)
      else if (money.pay === 'deposit')
        gateway.recordPayment(row.id, money.depositCents, { deposit: true, method: 'Visa ••4421' })
    }
  })

  afterAll(async () => {
    await t?.close()
  })

  return {
    get t() {
      return t
    },
    get ctx() {
      return ctx
    },
    gateway,
    memberships,
    queue,
    ids,
    get locationId() {
      return locationId
    },
  }
}
