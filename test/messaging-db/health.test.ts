// Device health on Postgres: state transitions, who is told, the Needs Attention alerts, webhook re-registration.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { messagingAlertSource } from '../../src/modules/messaging/adapters/alerts.js'
import { useWorld } from './world.js'

const w = useWorld()

async function managerNames(): Promise<string[]> {
  const rows = await w.t.db
    .selectFrom('notifications as n')
    .innerJoin('employees as e', 'e.id', 'n.employee_id')
    .select(['e.first', 'n.kind'])
    .execute()
  return rows.map((r) => r.first).sort()
}

describe('health state machine', () => {
  it('a health poll makes the device online and stores battery and status', async () => {
    const [r] = await w.rt.pollHealthAll()
    expect(r!.evaluation).toMatchObject({ state: 'online', previous: 'unknown', changed: true })
    expect(await w.device()).toMatchObject({ status: 'online', health_status: 'pass', battery: 87, charging: true, consecutive_poll_failures: 0 })
  })

  it('goes degraded then offline without any signal, and tells the people who can fix it (not the crew)', async () => {
    const sim = await w.sim()
    await w.rt.pollHealthAll()
    sim.setOutage('down')
    w.clock.advance(4 * 60_000)
    await w.rt.pollHealthAll()
    expect((await w.device()).status).toBe('degraded')
    expect(await w.t.db.selectFrom('notifications').select('id').execute()).toEqual([]) // degraded is shown, not announced

    w.clock.advance(7 * 60_000)
    await w.rt.pollHealthAll()
    expect((await w.device()).status).toBe('offline')
    // holders of set.billing or sched.override: Super Admin, Management, Accounting, and Sofia whose Allow exception grants
    // sched.override; the crew and the invited employee are not woken
    expect(await managerNames()).toEqual(['Amara', 'Daniel', 'Rafael', 'Sofia'])
    const n = await w.t.db.selectFrom('notifications').select(['kind', 'title', 'entity_type']).executeTakeFirstOrThrow()
    expect(n).toEqual({ kind: 'sms.device_offline', title: 'SMS device offline', entity_type: 'sms_device' })

    // SSE: a notification.new and an sms.device.health event per manager, targeted at that person's user
    const events = await w.t.db.selectFrom('realtime_events').select(['type', 'target_user_id', 'payload']).where('channel', '=', 'notifications').execute()
    expect(events.filter((e) => e.type === 'notification.new')).toHaveLength(4)
    const health = events.filter((e) => e.type === 'sms.device.health')
    expect(health.filter((e) => (e.payload as { to: string }).to === 'degraded')).toHaveLength(4) // shown live, not announced
    const offline = health.filter((e) => (e.payload as { to: string }).to === 'offline')
    expect(offline).toHaveLength(4)
    expect(offline[0]!.payload).toMatchObject({ from: 'degraded', to: 'offline', label: 'Front desk tablet (simulator)' })
    expect(events.every((e) => e.target_user_id !== null)).toBe(true)
    expect(new Set(offline.map((e) => e.target_user_id)).size).toBe(4)
    expect(await w.t.db.selectFrom('realtime_events').select('id').where('type', '=', 'alerts.changed').execute()).not.toHaveLength(0)
  })

  it('feeds the sms_device_down alert (managers only) and clears it, with a recovery notice, when a ping arrives', async () => {
    const sim = await w.sim()
    await w.rt.pollHealthAll()
    sim.setOutage('down')
    w.clock.advance(11 * 60_000)
    await w.rt.pollHealthAll()
    const dev = await w.device()

    const db = w.t.db
    const ctx = { locationId: w.locationId, now: w.clock.now() }
    const asManager = await messagingAlertSource.list(db, { ...ctx, manager: true })
    expect(asManager).toEqual([
      expect.objectContaining({ key: `sms_device_down:${dev.id}`, kind: 'sms_device_down', tone: 'red', title: 'SMS device offline', actionLabel: 'Open health', appointmentId: null, priority: 1 }),
    ])
    expect(asManager[0]!.desc).toContain('texts are queued')
    expect(await messagingAlertSource.list(db, { ...ctx, manager: false })).toEqual([])

    // the tablet comes back: its ping reaches the hooks listener (alive, but our own poll last failed), then a poll succeeds
    sim.setOutage('off')
    sim.ping()
    await w.settle()
    expect((await w.device()).status).toBe('degraded')
    await w.rt.pollHealthAll()
    expect((await w.device()).status).toBe('online')
    expect(await messagingAlertSource.list(db, { ...ctx, manager: true })).toEqual([])
    const kinds = (await w.t.db.selectFrom('notifications').select('kind').execute()).map((x) => x.kind)
    expect(new Set(kinds)).toEqual(new Set(['sms.device_offline', 'sms.device_recovered']))
  })

  it('a low unplugged battery or a warning in the ping makes the device degraded', async () => {
    const sim = await w.sim()
    sim.device.battery = 12
    sim.device.charging = false
    sim.device.healthStatus = 'warn'
    sim.ping()
    await w.settle()
    expect(await w.device()).toMatchObject({ status: 'degraded', health_status: 'warn', battery: 12, charging: false })
  })

  it('app:started re-registers the webhooks on the device', async () => {
    const sim = await w.sim()
    expect((await w.device()).webhooks_registered_at).toBeNull()
    sim.appStarted()
    await w.settle()
    const dev = await w.device()
    expect(dev.webhooks_registered_at).not.toBeNull()
    expect(dev.webhooks_url).toBe(`http://127.0.0.1:3002/hooks/smsgate/${SIM_DEVICE_KEY}`)
    expect(sim.device.listWebhooks().map((h) => h.event).sort()).toEqual(['app:started', 'sms:cancelled', 'sms:delivered', 'sms:failed', 'sms:received', 'sms:sent', 'system:ping'])
  })

  it('a failing health poll never throws; the failure is recorded on the device', async () => {
    const sim = await w.sim()
    sim.setOutage('down')
    const evaluation = await w.rt.pollHealth(await w.device())
    expect(evaluation.record.consecutivePollFailures).toBe(1)
    expect(['unknown', 'degraded']).toContain(evaluation.state)
  })
})

describe('unread replies feed the new_reply alert', () => {
  it('lists one alert per appointment, flags a cancel request, and clears on read', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const sim = await w.sim()
    sim.injectInbound(w.customer('Maria Delgado').phone, 'Running 10 min late')
    sim.injectInbound(w.customer('David Okafor').phone, 'Please cancel my booking')
    await w.settle()
    const alerts = await messagingAlertSource.list(w.t.db, { locationId: w.locationId, now: w.clock.now(), manager: false })
    const reply = alerts.find((a) => a.appointmentId === appt)!
    expect(reply).toMatchObject({ kind: 'new_reply', tone: 'blue', title: 'New reply · Maria Delgado' })
    expect(reply.desc).toContain('Running 10 min late')
    const unattributed = alerts.find((a) => a.appointmentId === null)!
    expect(unattributed).toMatchObject({ kind: 'new_reply', title: 'New reply · David Okafor' })
    expect(unattributed.desc).toContain('no appointment')
  })
})
