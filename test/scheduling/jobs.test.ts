// The per-minute alerts scan emits only when the alert set changes; photo housekeeping; the job registry.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import {
  alertSetKey,
  alertsScanJob,
  runAlertsScan,
  scanAlertsFor,
} from '../../src/modules/scheduling/jobs.js'
import { confirmAppointment } from '../../src/modules/scheduling/lifecycle.js'
import { finalizePendingUploads, PENDING_UPLOAD_TTL_MS } from '../../src/modules/scheduling/photo-jobs.js'
import { presignPhoto } from '../../src/modules/scheduling/photos.js'
import { useOps } from './helpers.js'

const o = useOps()
const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`
const events = async () => {
  const r = await sql<{
    type: string
    payload: Record<string, unknown>
  }>`select type, payload from realtime_events where type in ('alerts.changed') order by id`.execute(o.t.db)
  return r.rows
}

describe('appointments.late_scan', () => {
  it('is registered every minute, with the photo jobs', () => {
    const names = jobDefinitions.map((j) => j.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'maintenance.purge',
        'appointments.late_scan',
        'photos.thumbnail',
        'photos.finalize',
      ]),
    )
    expect(alertsScanJob).toMatchObject({ name: 'appointments.late_scan', cron: '* * * * *' })
  })

  it('an empty set is the starting point: nothing is announced', async () => {
    expect(await scanAlertsFor(o.t.db, o.ctx)).toMatchObject({ changed: false, count: 0 })
    expect(await events()).toEqual([])
  })

  it('announces a new alert once, stays quiet while the set is the same, announces again when it changes', async () => {
    await o.insert({
      customerName: 'Grace Adeyemi',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'booked',
      plannedBay: 2,
    })
    const first = await scanAlertsFor(o.t.db, o.ctx)
    expect(first).toMatchObject({ changed: true, count: 1 })
    expect(await events()).toEqual([{ type: 'alerts.changed', payload: { count: 1, added: 1, removed: 0 } }])
    const kpi = await sql<{
      n: number
    }>`select count(*)::int as n from realtime_events where type = 'kpi.dirty'`.execute(o.t.db)
    expect(kpi.rows[0]!.n).toBe(1)

    o.clock.advance(60_000)
    expect(await scanAlertsFor(o.t.db, o.ctx)).toMatchObject({ changed: false, count: 1 })
    o.clock.advance(60_000)
    expect(await scanAlertsFor(o.t.db, o.ctx)).toMatchObject({ changed: false })
    expect(await events()).toHaveLength(1)

    // a second booked job arrives: the set changes
    await o.insert({
      customerName: 'Tom Bradley',
      serviceName: 'Express Hand Wash',
      at: at('12:00'),
      status: 'booked',
      plannedBay: 1,
    })
    expect(await scanAlertsFor(o.t.db, o.ctx)).toMatchObject({ changed: true, count: 2 })
    expect((await events()).at(-1)!.payload).toEqual({ count: 2, added: 1, removed: 0 })
  })

  it('time alone raises an alert: a confirmed job becomes "Running late" once the grace has passed', async () => {
    await o.insert({
      customerName: 'Marcus Webb',
      serviceName: 'Express Hand Wash',
      at: at('10:40'),
      status: 'confirmed',
      plannedBay: 1,
    })
    // 10:36: arriving soon (within 15 minutes)
    expect(await scanAlertsFor(o.t.db, o.ctx)).toMatchObject({ changed: true, count: 1 })
    o.clock.set(at('10:50'))
    // arriving soon is gone (the start is past), late is not yet (10 minutes of grace): the set changed once
    expect(await scanAlertsFor(o.t.db, o.ctx)).toMatchObject({ changed: true, count: 0 })
    o.clock.set(at('10:51'))
    const late = await scanAlertsFor(o.t.db, o.ctx)
    expect(late).toMatchObject({ changed: true, count: 1 })
    expect((await events()).at(-1)!.payload).toEqual({ count: 1, added: 1, removed: 0 })
    const { rows } = await sql<{ alert_keys: string[] }>`select alert_keys from ops_alert_state`.execute(
      o.t.db,
    )
    expect(rows[0]!.alert_keys[0]).toMatch(/^running_late:/)
  })

  it('resolving an alert announces its removal', async () => {
    const b = await o.book({ at: at('14:00') })
    await scanAlertsFor(o.t.db, o.ctx)
    const actor = await o.actor()
    await o.tx((tx) => confirmAppointment(tx, o.ctx, actor, b.appointment.id))
    const r = await scanAlertsFor(o.t.db, o.ctx)
    expect(r).toMatchObject({ changed: true, count: 0 })
    expect((await events()).at(-1)!.payload).toEqual({ count: 0, added: 0, removed: 1 })
  })

  it('runAlertsScan covers every location and the set identity ignores order and wording', async () => {
    await o.insert({
      customerName: 'Grace Adeyemi',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'booked',
      plannedBay: 2,
    })
    const out = await runAlertsScan(o.t.db, o.clock, o.ctx.ports)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ changed: true, count: 1 })
    const a = { key: 'x:1', priority: 0 } as never
    const b = { key: 'y:2', priority: 1 } as never
    expect(alertSetKey([a, b]).hash).toBe(alertSetKey([b, a]).hash)
    expect(alertSetKey([a]).hash).not.toBe(alertSetKey([{ key: 'x:1', priority: 1 } as never]).hash)
  })
})

describe('photos.finalize', () => {
  it('removes uploads that stayed pending longer than 15 minutes, and only those', async () => {
    const b = await o.book({ at: at('14:00') })
    const actor = await o.actor()
    const old = await o.tx((tx) =>
      presignPhoto(tx, o.ctx, actor, b.appointment.id, {
        category: 'before',
        contentType: 'image/png',
        bytes: 100,
      }),
    )
    await o.t.db
      .updateTable('appointment_photos')
      .set({ created_at: new Date(o.clock.now().getTime() - PENDING_UPLOAD_TTL_MS - 1) })
      .where('id', '=', old.photoId)
      .execute()
    const fresh = await o.tx((tx) =>
      presignPhoto(tx, o.ctx, actor, b.appointment.id, {
        category: 'after',
        contentType: 'image/png',
        bytes: 100,
      }),
    )
    expect(await finalizePendingUploads(o.t.db, o.clock.now())).toBe(1)
    const rows = await o.t.db
      .selectFrom('appointment_photos')
      .select(['id', 'status'])
      .orderBy('id')
      .execute()
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [old.photoId]: 'deleted',
      [fresh.photoId]: 'pending_upload',
    })
    expect(await finalizePendingUploads(o.t.db, o.clock.now())).toBe(0)
  })
})
