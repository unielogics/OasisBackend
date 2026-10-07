// Shared setup for the membership tests: the real app with the session authorizer, the design customers and catalog, members
// created through the real route, and bookings with the real invoice gateway.
import { beforeEach } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import type { PlanKey } from '../../src/modules/memberships/schema.js'
import { useHarness, type Harness, type Session } from '../auth/harness.js'
import { SECRETS_KEY } from '../payments-sync-db/harness.js'

let keyN = 0
export const key = (): string => `mem-key-${++keyN}-${'m'.repeat(8)}`

export interface MemRig {
  h: Harness
  superS: () => Session
  limited: () => Session
  noMember: () => Session
  locationId: () => string
  customer(name: string): Promise<string>
  member(
    name: string,
    plan: PlanKey,
    o?: { label?: string; renewsOn?: string },
  ): Promise<{ id: string; customerId: string }>
  book(
    customerName: string,
    service: string,
    start?: string,
  ): Promise<{ appointmentId: string; invoiceId: string }>
  complete(appointmentId: string): Promise<void>
  send(
    s: Session,
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    idem?: string | false,
  ): ReturnType<Harness['call']>
  get(s: Session, url: string): ReturnType<Harness['call']>
}

export function useMemRig(): MemRig {
  const h = useHarness({ env: { SECRETS_KEY, SQSP_PROVIDER: 'sim', STORAGE_PROVIDER: 'fs' } })
  let superS: Session
  let limited: Session
  let noMember: Session
  let ip = 0
  const addr = () => `10.66.${Math.floor(ip / 200)}.${(ip++ % 200) + 1}`
  const locationId = () => h.t.location.id

  beforeEach(async () => {
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'domain-design' })
    await ensurePlans(h.t.db, { locationId: locationId(), clock: h.clock, newId: h.t.app.newId })
    const amara = await h.createUser({ email: 'amara@example.test', roles: ['super'] })
    superS = await h.login(amara, addr())
    limited = (await h.userWithPermissions(['cli.member', 'cli.view', 'sched.view'], 'limited@example.test'))
      .session
    noMember = (await h.userWithPermissions(['pay.adjust', 'cli.view'], 'nomember@example.test')).session
  })

  const self: MemRig = {
    h,
    superS: () => superS,
    limited: () => limited,
    noMember: () => noMember,
    locationId,
    async customer(name) {
      return (
        await h.t.db
          .selectFrom('customers')
          .select('id')
          .where('full_name', '=', name)
          .executeTakeFirstOrThrow()
      ).id
    },
    send: (s, method, url, body, idem) =>
      h.call(method, `/api/v1${url}`, {
        session: s,
        body: body ?? {},
        headers: idem === false ? {} : { 'idempotency-key': idem ?? key() },
        ip: addr(),
      }),
    get: (s, url) => h.call('GET', `/api/v1${url}`, { session: s, ip: addr() }),
    async member(name, plan, o = {}) {
      const customerId = await self.customer(name)
      const res = await self.send(superS, 'POST', '/memberships', {
        customerId,
        planKey: plan,
        ...(o.label ? { planLabel: o.label } : {}),
        renewsOn: o.renewsOn ?? '2026-07-12',
      })
      if (res.statusCode !== 201) throw new Error(`member create failed ${res.statusCode} ${res.body}`)
      return { id: (res.json() as { membership: { id: string } }).membership.id, customerId }
    },
    async book(customerName, service, start = '2026-06-13T14:00:00-04:00') {
      const customerId = await self.customer(customerName)
      const svc = await h.t.db
        .selectFrom('services')
        .select('id')
        .where('name', '=', service)
        .where('kind', '=', 'package')
        .executeTakeFirstOrThrow()
      const res = await self.send(superS, 'POST', '/appointments', {
        customer: { id: customerId },
        serviceId: svc.id,
        start,
      })
      if (res.statusCode !== 201) throw new Error(`booking failed ${res.statusCode} ${res.body}`)
      const b = res.json() as { appointment: { id: string }; invoice: { invoiceId: string } }
      const inv = await h.t.db
        .selectFrom('invoices')
        .select('id')
        .where('appointment_id', '=', b.appointment.id)
        .executeTakeFirstOrThrow()
      return { appointmentId: b.appointment.id, invoiceId: inv.id }
    },
    async complete(appointmentId) {
      for (const from of ['booked', 'confirmed', 'arrived', 'cleaning'] as const) {
        const r = await self.send(
          superS,
          'POST',
          `/appointments/${appointmentId}/advance`,
          { expectedStatus: from },
          false,
        )
        if (r.statusCode !== 200) throw new Error(`advance from ${from}: ${r.statusCode} ${r.body}`)
      }
    },
  }
  return self
}
