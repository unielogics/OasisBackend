// The seams between independently built modules, through the real production composition (apiModules +
// configureProductionSettings): the real invoice numbering at booking, the invoice date freeze on completion,
// cash-basis revenue from the ledger in the KPI, and the checklist sync triggered by the Settings route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { configureProductionSettings } from '../../src/composition.js'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { runSeed } from '../../db/seeds/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { makeUser } from '../helpers/factories.js'

let t: TestDb
let app: TestApp
const clock = new FixedClock(PARITY_NOW)
let keyN = 0
const key = (): string => `wiring-key-${++keyN}-${'x'.repeat(8)}`

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  withKey = method !== 'GET',
): Promise<LightMyRequestResponse> {
  return app.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: withKey ? { 'idempotency-key': key() } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  })
}
interface Booked {
  appointment: { id: string }
  invoice: { invoiceNo: number }
}
interface ServiceList {
  packages: { id: string; version: number; tasks: { id: string; label: string }[] }[]
}
const json = <T>(r: LightMyRequestResponse): T => r.json() as T

beforeAll(async () => {
  t = await createTestDb({ clock, poolMax: 8 })
  await truncateAll(t.db)
  await runSeed({ db: t.db, clock, profile: 'design' })
  const user = await makeUser(t.db, createIdGenerator(clock), { first: 'Desk' })
  configureProductionSettings({ clock, newId: createIdGenerator(clock) })
  app = await createTestApp({
    testDb: t,
    modules: apiModules,
    authorizer: (location) =>
      createPermissiveAuthorizer({
        locationId: location.id,
        userId: user.userId,
        employeeId: user.employeeId,
        actorName: 'Desk U.',
      }),
    env: { STORAGE_PROVIDER: 'fs' },
  })
})
afterAll(async () => {
  await app?.close()
})

describe('scheduling + payments + settings composition', () => {
  it('books with the REAL invoice gateway, freezes the invoice date on completion, and counts cash-basis revenue', async () => {
    const customer = await t.db.selectFrom('customers').select('id').where('full_name', '=', 'Maria Delgado').executeTakeFirstOrThrow()
    const express = await t.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').where('kind', '=', 'package').executeTakeFirstOrThrow()
    const booked = await call('POST', '/appointments', {
      customer: { id: customer.id },
      serviceId: express.id,
      start: '2026-06-13T14:00:00-04:00',
    })
    expect(booked.statusCode).toBe(201)
    const b = json<Booked>(booked)
    expect(b.invoice.invoiceNo).toBe(20611)
    const inv = await t.db.selectFrom('invoices').selectAll().where('appointment_id', '=', b.appointment.id).executeTakeFirstOrThrow()
    expect(inv.invoice_no).toBe(20611)
    expect(inv.date_frozen_at).toBeNull()

    for (const from of ['booked', 'confirmed', 'arrived', 'cleaning'] as const) {
      const r = await call('POST', `/appointments/${b.appointment.id}/advance`, { expectedStatus: from }, false)
      expect(r.statusCode, `${from}: ${r.body}`).toBe(200)
    }
    const done = await t.db.selectFrom('invoices').select(['date_frozen_at', 'biz_date']).where('id', '=', inv.id).executeTakeFirstOrThrow()
    expect(done.date_frozen_at).not.toBeNull()

    const collected = await call('POST', `/invoices/${inv.id}/payments`, { method: 'cash' })
    expect(collected.statusCode, collected.body).toBe(201)

    const kpis = json<{ kpis: { label: string; value: string }[] }>(await call('GET', '/ops/kpis')).kpis
    const revenue = kpis.find((k) => /revenue/i.test(k.label))
    expect(revenue?.value).toBe('$48.15') // $45.00 package + 7% tax, collected in cash
  })

  it('a payment today for tomorrow\'s job counts as cash-basis revenue, and a checklist edit through the Settings route reaches a job that has not started', async () => {
    const customer = await t.db.selectFrom('customers').select('id').where('full_name', '=', 'Liam Chen').executeTakeFirstOrThrow()
    const pkg = await t.db.selectFrom('services').select(['id']).where('name', '=', 'Family Wash + Pet Hair').where('kind', '=', 'package').executeTakeFirstOrThrow()
    const booked = json<Booked>(
      await call('POST', '/appointments', {
        customer: { id: customer.id },
        serviceId: pkg.id,
        start: '2026-06-14T09:00:00-04:00',
      }),
    )
    // Cash basis: money collected today counts today even for tomorrow's job (the no-ledger fallback would ignore it).
    const tomorrowInvoice = await t.db.selectFrom('invoices').select(['id', 'invoice_no']).where('appointment_id', '=', booked.appointment.id).executeTakeFirstOrThrow()
    expect((await call('POST', `/invoices/${tomorrowInvoice.id}/payments`, { method: 'cash' })).statusCode).toBe(201)
    const revenue = json<{ kpis: { label: string; value: string }[] }>(await call('GET', '/ops/kpis')).kpis.find((k) => /revenue/i.test(k.label))
    expect(revenue?.value).toBe('$149.80') // $48.15 + Family Wash + Pet Hair ($95.00 + 7% tax = $101.65)
    const items = await t.db.selectFrom('job_checklist_items').select(['id', 'label', 'source_task_id']).where('appointment_id', '=', booked.appointment.id).orderBy('position').execute()
    expect(items.length).toBeGreaterThan(3)

    const services = json<ServiceList>(await call('GET', '/services'))
    const svc = services.packages.find((p) => p.id === pkg.id)!
    const tasks = svc.tasks.map((x, i) =>
      i === 0 ? { id: x.id, label: 'Renamed first task' } : { id: x.id, label: x.label },
    )
    const put = await call('PUT', `/services/${pkg.id}/checklist`, { version: svc.version, tasks })
    expect(put.statusCode, put.body).toBe(200)

    const after = await t.db.selectFrom('job_checklist_items').select(['label', 'source_task_id']).where('appointment_id', '=', booked.appointment.id).where('source_task_id', '=', items[0]!.source_task_id!).executeTakeFirstOrThrow()
    expect(after.label).toBe('Renamed first task')
  })
})
