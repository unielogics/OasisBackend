// Manager notices about the SMS channel that can repeat (ADR 0122): an SMS device flapping between offline and online is announced
// once per kind per window, and where it ends up is announced when the window closes; an app:started without a reboot is
// announced once per window; texts queued with no enabled device raise an alert and one notice per episode.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { messagingAlertSource } from '../../src/modules/messaging/adapters/alerts.js'
import { FLAP_WINDOW_MS, NO_DEVICE_REPEAT_MS } from '../../src/modules/messaging/device-notices.js'
import { useWorld } from './world.js'

const w = useWorld()
const MIN = 60_000

/** Notices one manager (Amara, Super Admin) received, oldest first. */
async function amaraNotices(): Promise<Array<{ kind: string; body: string | null }>> {
  return w.t.db
    .selectFrom('notifications as n')
    .innerJoin('employees as e', 'e.id', 'n.employee_id')
    .select(['n.kind', 'n.body'])
    .where('e.first', '=', 'Amara')
    .orderBy('n.created_at')
    .orderBy('n.id')
    .execute()
}

async function reset(): Promise<void> {
  await sql`delete from notice_debounce`.execute(w.t.db)
}

async function goOffline(): Promise<void> {
  const sim = await w.sim()
  sim.setOutage('down')
  w.clock.advance(11 * MIN)
  await w.rt.pollHealthAll()
  expect((await w.device()).status).toBe('offline')
}

async function comeBack(): Promise<void> {
  const sim = await w.sim()
  sim.setOutage('off')
  await w.rt.pollHealthAll()
  expect((await w.device()).status).toBe('online')
}

describe('device offline / back online', () => {
  it('announces each kind at most once per flap window, and the end state when the window closes', async () => {
    await reset()
    await w.rt.pollHealthAll()
    await goOffline()
    await comeBack()
    expect((await amaraNotices()).map((n) => n.kind)).toEqual(['sms.device_offline', 'sms.device_recovered'])

    // it flaps: offline and back twice more inside the window, ending offline; nothing new is announced yet...
    await goOffline()
    await comeBack()
    await goOffline()
    expect((await amaraNotices()).map((n) => n.kind)).toEqual(['sms.device_offline', 'sms.device_recovered'])
    // ...but every change still reaches the managers live
    const live = await w.t.db
      .selectFrom('realtime_events')
      .select('payload')
      .where('type', '=', 'sms.device.health')
      .execute()
    expect(live.length).toBeGreaterThanOrEqual(5 * 4)

    // the window since the first offline notice closes with the device still offline: announced once, with the flaps counted
    w.clock.advance(FLAP_WINDOW_MS)
    await w.rt.pollHealthAll()
    const notices = await amaraNotices()
    expect(notices.map((n) => n.kind)).toEqual([
      'sms.device_offline',
      'sms.device_recovered',
      'sms.device_offline',
    ])
    expect(notices[2]!.body).toMatch(/changed \d+ more times? in the last 30 minutes/)
    await w.rt.pollHealthAll()
    expect(await amaraNotices()).toHaveLength(3)
  })

  it('says nothing more when a flapping device ends where the last notice left it', async () => {
    await reset()
    await w.rt.pollHealthAll()
    await goOffline()
    await comeBack()
    await goOffline()
    await comeBack()
    w.clock.advance(FLAP_WINDOW_MS)
    await w.rt.pollHealthAll()
    expect((await amaraNotices()).map((n) => n.kind)).toEqual(['sms.device_offline', 'sms.device_recovered'])
  })
})

describe('app:started without a reboot', () => {
  it('tells managers the app restarted while the tablet stayed reachable, once per window', async () => {
    await reset()
    const sim = await w.sim()
    await w.rt.pollHealthAll()
    w.clock.advance(30_000)
    sim.appStarted()
    await w.settle()
    expect((await amaraNotices()).map((n) => n.kind)).toEqual(['sms.app_restarted'])
    expect((await amaraNotices())[0]!.body).toContain('Unrestricted')
    w.clock.advance(20_000)
    sim.appStarted()
    await w.settle()
    expect(await amaraNotices()).toHaveLength(1)
  })

  it('stays quiet after a reboot (the tablet was unreachable first) and on the first signal ever', async () => {
    await reset()
    const sim = await w.sim()
    sim.appStarted() // never heard from before
    await w.settle()
    await w.rt.pollHealthAll()
    sim.setOutage('down')
    w.clock.advance(2 * MIN)
    await w.rt.pollHealthAll() // the reboot: a poll fails
    sim.setOutage('off')
    w.clock.advance(MIN)
    sim.appStarted()
    await w.settle()
    expect((await amaraNotices()).filter((n) => n.kind === 'sms.app_restarted')).toEqual([])
  })
})

describe('texts queued and no SMS device', () => {
  it('raises the alert and one notice per episode while texts wait with no device enabled', async () => {
    await reset()
    await sql`update sms_devices set enabled = false`.execute(w.t.db)
    const q = await w.tx((tx) =>
      w.rt.queue.enqueue(tx, {
        customerId: w.customer('Maria Delgado').id,
        appointmentId: null,
        templateKey: 'booking_thanks',
        vars: { first: 'Maria' },
        purpose: 'booking',
      }),
    )
    expect(q.queued).toBe(true)
    const alerts = await messagingAlertSource.list(w.t.db, {
      locationId: w.locationId,
      now: w.clock.now(),
      manager: true,
    })
    expect(alerts).toEqual([
      expect.objectContaining({
        key: 'sms_no_device',
        kind: 'sms_device_down',
        tone: 'red',
        title: 'No SMS device',
      }),
    ])
    expect(
      await messagingAlertSource.list(w.t.db, {
        locationId: w.locationId,
        now: w.clock.now(),
        manager: false,
      }),
    ).toEqual([])

    await w.tick()
    await w.tick()
    await w.rt.pollHealthAll()
    expect((await amaraNotices()).map((n) => n.kind)).toEqual(['sms.no_device'])
    expect((await amaraNotices())[0]!.body).toBe(
      '1 text is waiting to be sent and no SMS device is enabled. Enable the tablet in Settings, or add one.',
    )
    // still unresolved hours later: reminded once
    w.clock.advance(NO_DEVICE_REPEAT_MS)
    await w.tick()
    await w.tick()
    expect((await amaraNotices()).map((n) => n.kind)).toEqual(['sms.no_device', 'sms.no_device'])

    // a device comes back: the episode ends and the alert clears; a later episode is announced again
    await sql`update sms_devices set enabled = true`.execute(w.t.db)
    await w.rt.pollHealthAll()
    expect(
      (
        await messagingAlertSource.list(w.t.db, {
          locationId: w.locationId,
          now: w.clock.now(),
          manager: true,
        })
      ).filter((a) => a.key === 'sms_no_device'),
    ).toEqual([])
    expect(
      (
        await w.t.db
          .selectFrom('notice_debounce')
          .select('state')
          .where('key', '=', 'sms.no_device')
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('closed')
  })
})
