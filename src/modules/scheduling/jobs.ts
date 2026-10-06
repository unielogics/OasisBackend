// The per-minute alerts scan (appointments.late_scan). Alerts depend on the clock (running late, arriving soon), so
// nothing writes an event when one appears; the scan recomputes the set every minute and publishes alerts.changed and
// kpi.dirty only when the set differs from the one it last announced.
import { createHash } from 'node:crypto'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db } from '../../platform/db.js'
import { createIdGenerator } from '../../platform/ids.js'
import type { JobDefinition } from '../../platform/jobs.js'
import * as realtime from '../../platform/realtime.js'
import { loadAlerts, type Alert } from './alerts.js'
import { locationTimezone, type SchedulingCtx } from './context.js'
import {
  InMemoryInvoiceGateway,
  InMemoryMessageQueue,
  noExternalAlerts,
  noMemberships,
  type SchedulingPorts,
} from './ports.js'
import './schema.js'
import type { StorageProvider } from '../../integrations/ports/storage.js'

let configured: Partial<SchedulingPorts> = {}

/** The worker process wires the real ports here (the API process passes them to createSchedulingModule). */
export function configureSchedulingJobs(ports: Partial<SchedulingPorts>): void {
  configured = ports
}

const unusedStorage = (): StorageProvider => ({
  createUpload: () => Promise.reject(new Error('storage is not used by the alerts scan')),
  head: () => Promise.reject(new Error('storage is not used by the alerts scan')),
  getDownloadUrl: () => Promise.reject(new Error('storage is not used by the alerts scan')),
  delete: () => Promise.reject(new Error('storage is not used by the alerts scan')),
})

export function jobPorts(): SchedulingPorts {
  return {
    invoices: configured.invoices ?? new InMemoryInvoiceGateway(),
    messages: configured.messages ?? new InMemoryMessageQueue(),
    memberships: configured.memberships ?? noMemberships,
    externalAlerts: configured.externalAlerts ?? noExternalAlerts,
    revenue: configured.revenue,
    storage: configured.storage ?? unusedStorage(),
  }
}

/** The identity of an alert set for change detection: which alerts exist and at which priority. */
export function alertSetKey(alerts: readonly Alert[]): { hash: string; keys: string[] } {
  const keys = alerts.map((a) => `${a.key}|${a.priority}`).sort()
  return { hash: createHash('sha256').update(keys.join('\n')).digest('hex'), keys }
}

export interface ScanResult {
  changed: boolean
  count: number
  hash: string
}

export async function scanAlertsFor(
  db: Db,
  c: SchedulingCtx,
): Promise<ScanResult> {
  const alerts = await loadAlerts(db, c, { manager: true })
  const { hash, keys } = alertSetKey(alerts)
  return transaction(db, async (tx) => {
    const prev = await tx
      .selectFrom('ops_alert_state')
      .select(['alerts_hash', 'alert_keys'])
      .where('location_id', '=', c.locationId)
      .forUpdate()
      .executeTakeFirst()
    const prevHash = prev?.alerts_hash ?? alertSetKey([]).hash
    if (prevHash === hash) return { changed: false, count: alerts.length, hash }
    await tx
      .insertInto('ops_alert_state')
      .values({ location_id: c.locationId, alerts_hash: hash, alert_keys: keys, updated_at: c.clock.now() })
      .onConflict((oc) =>
        oc.column('location_id').doUpdateSet({ alerts_hash: hash, alert_keys: keys, updated_at: c.clock.now() }),
      )
      .execute()
    const before = new Set(prev?.alert_keys ?? [])
    const after = new Set(keys)
    await realtime.publish(tx, {
      locationId: c.locationId,
      channel: 'ops',
      type: 'alerts.changed',
      payload: {
        count: alerts.length,
        added: keys.filter((k) => !before.has(k)).length,
        removed: [...before].filter((k) => !after.has(k)).length,
      },
    })
    await realtime.publish(tx, { locationId: c.locationId, channel: 'ops', type: 'kpi.dirty', payload: {} })
    return { changed: true, count: alerts.length, hash }
  })
}

export async function runAlertsScan(db: Db, clock: Clock, ports: SchedulingPorts = jobPorts()): Promise<ScanResult[]> {
  const locations = await db.selectFrom('locations').select('id').orderBy('created_at').execute()
  const newId = createIdGenerator(clock)
  const out: ScanResult[] = []
  for (const l of locations) {
    const tz = await locationTimezone(db, l.id)
    out.push(await scanAlertsFor(db, { clock, newId, locationId: l.id, tz, ports }))
  }
  return out
}

export const alertsScanJob: JobDefinition = {
  name: 'appointments.late_scan',
  policy: 'short',
  cron: '* * * * *',
  retryLimit: 0,
  async handler(ctx) {
    const results = await runAlertsScan(ctx.db, ctx.clock)
    if (results.some((r) => r.changed)) ctx.logger.info({ alerts: results.map((r) => r.count) }, 'alert set changed')
  },
}

