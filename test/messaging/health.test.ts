import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../src/platform/clock.js'
import { computeDeviceState, DEFAULT_HEALTH, DeviceHealthMonitor, freshRecord, InMemoryDeviceRepository, type HealthEvaluation } from '../../src/modules/messaging/dispatch/index.js'

const T0 = new Date('2026-06-13T12:00:00-04:00')
const min = (n: number): number => n * 60_000

function setup() {
  const clock = new FixedClock(T0)
  const monitor = new DeviceHealthMonitor(new InMemoryDeviceRepository(), clock, DEFAULT_HEALTH)
  const seen: HealthEvaluation[] = []
  monitor.onTransition((e) => seen.push(e))
  return { clock, monitor, seen }
}

describe('computeDeviceState', () => {
  const rec = (over: Partial<ReturnType<typeof freshRecord>>) => ({ ...freshRecord('d'), ...over })

  it('is unknown until the first signal', () => {
    expect(computeDeviceState(rec({}), T0, DEFAULT_HEALTH).state).toBe('unknown')
  })

  it('is online within 3 minutes, degraded to 10, offline beyond', () => {
    const r = rec({ lastSeenAt: T0, state: 'online' })
    expect(computeDeviceState(r, new Date(T0.getTime() + min(3)), DEFAULT_HEALTH).state).toBe('online')
    expect(computeDeviceState(r, new Date(T0.getTime() + min(3) + 1), DEFAULT_HEALTH).state).toBe('degraded')
    expect(computeDeviceState(r, new Date(T0.getTime() + min(10)), DEFAULT_HEALTH).state).toBe('degraded')
    expect(computeDeviceState(r, new Date(T0.getTime() + min(10) + 1), DEFAULT_HEALTH).state).toBe('offline')
  })

  it('degrades on warn, fail, a failed poll and a low unplugged battery, not on a low plugged battery', () => {
    const base = { lastSeenAt: T0 }
    expect(computeDeviceState(rec({ ...base, healthStatus: 'warn' }), T0, DEFAULT_HEALTH).state).toBe('degraded')
    expect(computeDeviceState(rec({ ...base, healthStatus: 'fail' }), T0, DEFAULT_HEALTH).state).toBe('degraded')
    expect(computeDeviceState(rec({ ...base, consecutivePollFailures: 1 }), T0, DEFAULT_HEALTH).state).toBe('degraded')
    expect(computeDeviceState(rec({ ...base, battery: 12, charging: false }), T0, DEFAULT_HEALTH).state).toBe('degraded')
    expect(computeDeviceState(rec({ ...base, battery: 12, charging: true }), T0, DEFAULT_HEALTH).state).toBe('online')
    expect(computeDeviceState(rec({ ...base, battery: 80, charging: false }), T0, DEFAULT_HEALTH).state).toBe('online')
  })

  it('is offline after three consecutive failures even when recently heard from', () => {
    expect(computeDeviceState(rec({ lastSeenAt: T0, consecutivePollFailures: 3 }), T0, DEFAULT_HEALTH).state).toBe('offline')
  })
})

describe('DeviceHealthMonitor', () => {
  it('walks online -> degraded -> offline with silence and back with a signal', async () => {
    const { clock, monitor, seen } = setup()
    await monitor.record('d', { kind: 'poll_ok', at: clock.now() })
    expect((await monitor.evaluate('d')).state).toBe('online')
    clock.advance(min(4))
    expect((await monitor.evaluate('d')).state).toBe('degraded')
    clock.advance(min(7))
    expect((await monitor.evaluate('d')).state).toBe('offline')
    await monitor.record('d', { kind: 'ping', at: clock.now() })
    expect((await monitor.evaluate('d')).state).toBe('online')
    expect(seen.map((e) => `${e.previous}->${e.state}`)).toEqual(['unknown->online', 'online->degraded', 'degraded->offline', 'offline->online'])
  })

  it('only notifies on a change', async () => {
    const { clock, monitor, seen } = setup()
    await monitor.record('d', { kind: 'ping', at: clock.now() })
    await monitor.record('d', { kind: 'ping', at: clock.now() })
    await monitor.evaluate('d')
    expect(seen).toHaveLength(1)
  })

  it('three failed polls take it offline and one good poll recovers it', async () => {
    const { clock, monitor } = setup()
    await monitor.record('d', { kind: 'poll_ok', at: clock.now() })
    expect((await monitor.record('d', { kind: 'poll_failed', at: clock.now() })).state).toBe('degraded')
    await monitor.record('d', { kind: 'poll_failed', at: clock.now() })
    expect((await monitor.record('d', { kind: 'poll_failed', at: clock.now() })).state).toBe('offline')
    expect((await monitor.record('d', { kind: 'poll_ok', at: clock.now() })).state).toBe('online')
  })

  it('a ping alone does not clear failed polls: our path to the device is what matters for sending', async () => {
    const { clock, monitor } = setup()
    for (let i = 0; i < 3; i++) await monitor.record('d', { kind: 'poll_failed', at: clock.now() })
    expect((await monitor.record('d', { kind: 'ping', at: clock.now() })).state).toBe('offline')
  })

  it('records battery and health from pings and flags app:started', async () => {
    const { clock, monitor } = setup()
    const warn = await monitor.record('d', { kind: 'ping', at: clock.now(), healthStatus: 'warn', battery: 20, charging: true })
    expect(warn).toMatchObject({ state: 'degraded', appStarted: false, record: { battery: 20, charging: true, healthStatus: 'warn' } })
    const ok = await monitor.record('d', { kind: 'ping', at: clock.now(), healthStatus: 'pass' })
    expect(ok.state).toBe('online')
    const started = await monitor.record('d', { kind: 'app_started', at: clock.now() })
    expect(started.appStarted).toBe(true)
    expect(started.record.lastAppStartedAt).toEqual(clock.now())
  })

  it('never moves lastSeenAt backwards when a stale event arrives late', async () => {
    const { clock, monitor } = setup()
    await monitor.record('d', { kind: 'ping', at: new Date(T0.getTime() + min(5)) })
    const e = await monitor.record('d', { kind: 'ping', at: T0 })
    expect(e.record.lastSeenAt).toEqual(new Date(T0.getTime() + min(5)))
    void clock
  })
})
