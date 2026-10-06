// Shared fixtures for the scheduling tests: the `design` seed (people, bays, hours, catalog, customers, VIP list), a frozen
// clock at the design's 10:36 AM, in-memory ports, an actor with chosen permissions, and booking helpers.
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import type { AuthContext } from '../../src/http/authorizer.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { transaction, type Tx } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { listCatalog, type CatalogService } from '../../src/modules/catalog/service.js'
import { PERMISSION_KEYS } from '../../src/modules/rbac/catalog.js'
import type { Actor, SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { createAppointment, type BookingInput, type BookingResult } from '../../src/modules/scheduling/booking.js'
import {
  InMemoryInvoiceGateway,
  InMemoryMemberships,
  InMemoryMessageQueue,
  noExternalAlerts,
  type SchedulingPorts,
} from '../../src/modules/scheduling/ports.js'
import { FsStorage } from '../../src/integrations/storage/fs-provider.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { makeUser } from '../helpers/factories.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const ALL = [...PERMISSION_KEYS]

export interface Ops {
  readonly t: TestDb
  readonly clock: FixedClock
  readonly ctx: SchedulingCtx
  readonly ports: SchedulingPorts & { invoices: InMemoryInvoiceGateway; messages: InMemoryMessageQueue; memberships: InMemoryMemberships }
  readonly gateway: InMemoryInvoiceGateway
  readonly queue: InMemoryMessageQueue
  readonly memberships: InMemoryMemberships
  readonly locationId: string
  readonly storage: FsStorage
  /** Package or add-on by name. */
  svc(name: string): CatalogService
  customer(name: string): string
  bay(n: number): string
  employee(first: string): string
  /** An actor holding exactly these permissions (everything by default). */
  actor(perms?: readonly string[]): Promise<Actor>
  /** One transaction, like a request. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  book(o: Partial<BookingInput> & { serviceName?: string; customerName?: string; at?: string; actor?: Actor }): Promise<BookingResult>
  /** Writes an appointment row directly (any status), the way the seeds do. */
  insert(o: InsertAppointment): Promise<string>
}

export interface InsertAppointment {
  customerName: string
  serviceName: string
  /** ISO instant with offset. */
  at: string
  status?: string
  bay?: number | null
  plannedBay?: number | null
  staff?: string | null
  cleaningStartedAt?: string | null
  completedAt?: string | null
  etaMinutes?: number | null
  geoCheckedInAt?: string | null
  pickup?: 'pending' | 'collected' | null
  special?: string | null
  notes?: string | null
  vehiclePlate?: string
}

export const START = PARITY_NOW

export function useOps(o: { start?: string } = {}): Ops {
  let t: TestDb
  let clock: FixedClock
  let locationId = ''
  let catalog: CatalogService[] = []
  const customers = new Map<string, string>()
  const bays = new Map<number, string>()
  const employees = new Map<string, string>()
  const gateway = new InMemoryInvoiceGateway()
  const queue = new InMemoryMessageQueue()
  const memberships = new InMemoryMemberships()
  let storage: FsStorage
  let ctx: SchedulingCtx
  const start = o.start ?? START

  beforeAll(async () => {
    clock = new FixedClock(start)
    t = await createTestDb({ clock, poolMax: 8 })
    await truncateAll(t.db)
    await runSeed({ db: t.db, clock, profile: 'design' })
    const loc = await t.db.selectFrom('locations').select(['id']).executeTakeFirstOrThrow()
    locationId = loc.id
    const all = await listCatalog(t.db, locationId, { includeInactive: true })
    catalog = [...all.packages, ...all.addons]
    for (const c of await t.db.selectFrom('customers').select(['id', 'full_name']).execute())
      customers.set(c.full_name, c.id)
    for (const b of await t.db.selectFrom('bays').select(['id', 'number']).execute()) bays.set(b.number, b.id)
    for (const e of await t.db.selectFrom('employees').select(['id', 'first']).execute()) employees.set(e.first, e.id)
    storage = new FsStorage({
      root: mkdtempSync(path.join(tmpdir(), 'oasis-photos-')),
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
  })

  beforeEach(async () => {
    clock.set(start)
    queue.clear()
    queue.skipWhen = null
    memberships.byCustomer.clear()
    await sql`delete from appointments`.execute(t.db)
    await sql`delete from ops_alert_state`.execute(t.db)
    await sql`delete from realtime_events`.execute(t.db)
    await sql`truncate table audit_log`.execute(t.db)
    await sql`update bays set status = 'active'`.execute(t.db)
    await sql`delete from emergency_notifications`.execute(t.db)
    gateway.reset()
  })

  afterAll(async () => {
    await t?.close()
  })

  const self: Ops = {
    get t() {
      return t
    },
    get clock() {
      return clock
    },
    get ctx() {
      return ctx
    },
    get ports() {
      return ctx.ports as Ops['ports']
    },
    gateway,
    queue,
    memberships,
    get locationId() {
      return locationId
    },
    get storage() {
      return storage
    },
    svc(name) {
      const s = catalog.find((x) => x.name === name)
      if (!s) throw new Error(`no service ${name}`)
      return s
    },
    customer(name) {
      const id = customers.get(name)
      if (!id) throw new Error(`no customer ${name}`)
      return id
    },
    bay(n) {
      return bays.get(n)!
    },
    employee(first) {
      return employees.get(first)!
    },
    async actor(perms = ALL) {
      const u = await makeUser(t.db, ctx.newId)
      const auth: AuthContext = {
        userId: u.userId,
        employeeId: u.employeeId,
        locationId,
        permissions: new Set(perms),
        actorName: 'Test User',
        roles: ['test'],
      }
      return { auth, audit: { actor: { userId: u.userId, employeeId: u.employeeId, name: 'Test User', roles: 'test' }, requestId: 'req-test' } }
    },
    tx: (fn) => transaction(t.db, fn),
    async book(b) {
      const { serviceName, customerName, at, actor, ...rest } = b
      const a = actor ?? (await self.actor())
      const customerId = self.customer(customerName ?? 'Maria Delgado')
      const owned = await t.db.selectFrom('vehicles').select('plate').where('customer_id', '=', customerId).executeTakeFirst()
      return self.tx((tx) =>
        createAppointment(tx, ctx, a, {
          customer: { id: customerId },
          vehicle: owned?.plate ? { plate: owned.plate } : undefined,
          serviceId: self.svc(serviceName ?? 'Express Hand Wash').id,
          start: at ? new Date(at) : undefined,
          ...rest,
        }),
      )
    },
    async insert(i) {
      const svc = self.svc(i.serviceName)
      const customerId = self.customer(i.customerName)
      const veh = await t.db.selectFrom('vehicles').select('id').where('customer_id', '=', customerId).executeTakeFirst()
      const startAt = new Date(i.at)
      const id = ctx.newId()
      const status = (i.status ?? 'booked') as never
      await t.db
        .insertInto('appointments')
        .values({
          id,
          location_id: locationId,
          customer_id: customerId,
          vehicle_id: veh?.id ?? null,
          service_id: svc.id,
          package_name: svc.name,
          price_cents: svc.priceCents,
          duration_min: svc.durationMin,
          status,
          scheduled_start: startAt,
          scheduled_end: new Date(startAt.getTime() + svc.durationMin * 60_000),
          bay_id: i.bay ? bays.get(i.bay)! : null,
          planned_bay_id: i.plannedBay ? bays.get(i.plannedBay)! : i.bay ? bays.get(i.bay)! : null,
          assigned_employee_id: i.staff ? employees.get(i.staff)! : null,
          cleaning_started_at: i.cleaningStartedAt ? new Date(i.cleaningStartedAt) : null,
          completed_at: i.completedAt ? new Date(i.completedAt) : null,
          eta_minutes: i.etaMinutes ?? null,
          geo_checked_in_at: i.geoCheckedInAt ? new Date(i.geoCheckedInAt) : null,
          pickup_state: i.pickup ?? (status === 'completed' ? 'pending' : null),
          special_instructions: i.special ?? null,
          notes: i.notes ?? null,
        })
        .execute()
      await gateway.ensureForAppointment(undefined as never, {
        appointmentId: id,
        locationId,
        customerId,
        clientName: i.customerName,
        vehicleLabel: 'Vehicle',
        staffLabel: i.staff ?? 'Unassigned',
        occurredAt: startAt,
        packageName: svc.name,
        packagePriceCents: svc.priceCents,
        addons: [],
      })
      return id
    },
  }
  return self
}
