// Helpers for the standing-appointment and waitlist tests: the rig, the feature switch, the VIP toggles and a scheduling context
// over the real payments gateway with an inspectable message queue (jobs are exercised through their service functions).
import { sql } from 'kysely'
import { transaction, type Tx } from '../../src/platform/db.js'
import { createGatewayFor } from '../../src/modules/payments/module.js'
import { dbMembershipPort } from '../../src/modules/memberships/port.js'
import { locationTimezone, type SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { InMemoryMessageQueue, noExternalAlerts } from '../../src/modules/scheduling/ports.js'
import { createDbDepositSettlement } from '../../src/modules/scheduling/settlement.js'
import { dbWaitlistPort } from '../../src/modules/standing/waitlist.js'
import { idemKey, useRig, type Rig } from '../scheduling-gaps/support.js'

export { idemKey, useRig, type Rig }

export async function setFeature(m: Rig, on: boolean): Promise<void> {
  const cur = (await m.get(m.superS(), '/settings/features')).json() as { version: number }
  const res = await m.send(
    m.superS(),
    'PUT',
    '/settings/features',
    { standingWaitlist: on, version: cur.version },
    false,
  )
  if (res.statusCode !== 200) throw new Error(`feature switch failed ${res.statusCode} ${res.body}`)
}

export async function setVip(m: Rig, patch: Record<string, unknown>): Promise<void> {
  const cur = (await m.get(m.superS(), '/vip')).json() as { version: number }
  const res = await m.send(m.superS(), 'PUT', '/vip', { ...patch, version: cur.version }, false)
  if (res.statusCode !== 200) throw new Error(`vip settings failed ${res.statusCode} ${res.body}`)
}

export interface JobRig {
  queue: InMemoryMessageQueue
  ctx(): Promise<SchedulingCtx>
  tx<T>(fn: (tx: Tx, c: SchedulingCtx) => Promise<T>): Promise<T>
}

export function jobRig(m: Rig): JobRig {
  const queue = new InMemoryMessageQueue()
  const self: JobRig = {
    queue,
    async ctx() {
      const locationId = m.locationId()
      const newId = m.h.t.app.newId
      return {
        clock: m.h.clock,
        newId,
        locationId,
        tz: await locationTimezone(m.h.t.db, locationId),
        ports: {
          invoices: createGatewayFor({ clock: m.h.clock, newId }),
          messages: queue,
          memberships: dbMembershipPort,
          externalAlerts: noExternalAlerts,
          deposits: createDbDepositSettlement({ clock: m.h.clock, newId }),
          waitlist: dbWaitlistPort,
          storage: {
            createUpload: () => Promise.reject(new Error('unused')),
            head: () => Promise.reject(new Error('unused')),
            getDownloadUrl: () => Promise.reject(new Error('unused')),
            delete: () => Promise.reject(new Error('unused')),
          },
        },
      }
    },
    async tx(fn) {
      const c = await self.ctx()
      return transaction(m.h.t.db, (tx) => fn(tx, c))
    },
  }
  return self
}

export async function appointmentsOf(m: Rig, seriesId: string) {
  return (
    await sql<{ id: string; status: string; source: string; start: Date; vehicle_id: string | null }>`
      select id, status, source, scheduled_start as start, vehicle_id from appointments
      where standing_series_id = ${seriesId} order by scheduled_start`.execute(m.h.t.db)
  ).rows
}
