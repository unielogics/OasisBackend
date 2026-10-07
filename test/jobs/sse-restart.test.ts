// Realtime resilience against a real API process: events are durable in realtime_events, so a client that reconnects with
// Last-Event-ID after the API restarted (gracefully or killed) gets what it missed, in order, with no duplicate; a client
// whose cursor can no longer be replayed gets `resync`. The API is a separate node process (src/server.ts) on port 4027.
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { transaction } from '../../src/platform/db.js'
import { publish, purgeRealtimeEvents } from '../../src/platform/realtime.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { useTestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { openSse, sleep, type SseClient, type SseFrame } from '../helpers/sse.js'

const PORT = 4027
const BASE = `http://127.0.0.1:${PORT}`
const t = useTestDb()
let api: ChildProcess | undefined
let apiOutput = ''
let bossSchema = ''

beforeAll(() => {
  bossSchema = `pgb7_sse_${t.schema}`.slice(0, 63)
})

afterEach(async () => {
  await stopApi('SIGKILL')
})

afterAll(async () => {
  await sql`drop schema if exists ${sql.id(bossSchema)} cascade`.execute(t.db)
})

async function startApi(): Promise<void> {
  apiOutput = ''
  api = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/server.ts')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      HOOKS_PORT: '0',
      DATABASE_URL: testDatabaseUrl(),
      DB_SEARCH_PATH: `${t.schema},public`,
      PGBOSS_SCHEMA: bossSchema,
      JOBS_ENABLED: 'true',
      SMS_DISPATCH_MODE: 'off',
      DEV_AUTH_BYPASS: 'true',
      SSE_HEARTBEAT_MS: '1000',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  api.stdout!.on('data', (d: Buffer) => (apiOutput += d.toString()))
  api.stderr!.on('data', (d: Buffer) => (apiOutput += d.toString()))
  const child = api
  const end = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`API exited: ${apiOutput.slice(-2000)}`)
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > end) throw new Error(`API did not start: ${apiOutput.slice(-2000)}`)
    await sleep(250)
  }
}

async function stopApi(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const child = api
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill(signal)
  await exited
}

/** What a browser EventSource does: remembers the last event id and reconnects with Last-Event-ID after a drop. */
class ReconnectingSse {
  readonly frames: SseFrame[] = []
  lastId: string | undefined
  connections = 0
  private current: SseClient | undefined
  private stopped = false
  private loop: Promise<void>
  constructor(private readonly url: string) {
    this.loop = this.run()
  }
  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const c = await openSse(this.url, this.lastId ? { 'Last-Event-ID': this.lastId } : {})
        if (c.status !== 200) throw new Error(`status ${c.status}`)
        this.current = c
        this.connections += 1
        let seen = 0
        const pump = setInterval(() => {
          for (; seen < c.frames.length; seen++) {
            const f = c.frames[seen]!
            this.frames.push(f)
            if (f.id !== undefined) this.lastId = f.id
          }
        }, 20)
        await c.ended
        clearInterval(pump)
        for (; seen < c.frames.length; seen++) {
          const f = c.frames[seen]!
          this.frames.push(f)
          if (f.id !== undefined) this.lastId = f.id
        }
      } catch {
        // the server is down: try again
      }
      if (!this.stopped) await sleep(300)
    }
  }
  get messages(): SseFrame[] {
    return this.frames.filter((f) => f.event === undefined && f.data !== undefined)
  }
  get ids(): number[] {
    return this.messages.map((f) => Number(f.id))
  }
  async waitFor(pred: (f: SseFrame) => boolean, ms = 60_000): Promise<SseFrame> {
    const end = Date.now() + ms
    for (;;) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      if (Date.now() > end)
        throw new Error(`timed out; frames: ${JSON.stringify(this.frames.map((f) => f.raw))}`)
      await sleep(50)
    }
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.current?.close()
    await this.loop
  }
}

const locationId = async (): Promise<string> => (await ensureLocation(t.db, createIdGenerator(t.clock))).id
const pub = async (type: string): Promise<number> => {
  const loc = await locationId()
  return transaction(t.db, (tx) => publish(tx, { locationId: loc, channel: 'ops', type }))
}

describe('the event stream across an API restart', () => {
  it.each([['SIGTERM'], ['SIGKILL']] as const)(
    'replays what was missed, in order and without duplicates, after the API stops with %s and comes back',
    async (signal) => {
      await startApi()
      const client = new ReconnectingSse(`${BASE}/api/v1/events`)
      try {
        const ready = await client.waitFor((f) => f.event === 'ready')
        expect(ready.data).toMatchObject({
          channels: ['ops', 'payments', 'messages', 'settings', 'notifications'],
          denied: [],
        })
        const before = [await pub('e1'), await pub('e2')]
        await client.waitFor((f) => f.id === String(before[1]))
        expect(client.ids).toEqual(before)

        await stopApi(signal)
        // while the API is down, events keep being committed
        const missed = [await pub('e3'), await pub('e4'), await pub('e5')]
        await sleep(500)
        expect(client.ids).toEqual(before) // nothing arrived, the stream is gone

        await startApi()
        await client.waitFor((f) => f.id === String(missed[2]))
        const live = await pub('e6')
        await client.waitFor((f) => f.id === String(live))

        expect(client.ids).toEqual([...before, ...missed, live]) // exact order, each once
        expect(client.frames.some((f) => f.event === 'resync')).toBe(false)
        expect(client.connections).toBeGreaterThanOrEqual(2)
        expect(client.messages.map((f) => (f.data as { type: string }).type)).toEqual([
          'e1',
          'e2',
          'e3',
          'e4',
          'e5',
          'e6',
        ])
      } finally {
        await client.stop()
      }
    },
    180_000,
  )

  it('sends resync, and no replay, when the events the client missed were purged while the API was down', async () => {
    await startApi()
    const client = new ReconnectingSse(`${BASE}/api/v1/events`)
    try {
      await client.waitFor((f) => f.event === 'ready')
      const seen = await pub('seen')
      await client.waitFor((f) => f.id === String(seen))
      await stopApi('SIGTERM')
      await pub('lost-1')
      await pub('lost-2')
      // retention: everything older than "now + a day" is purged, the log remembers how far
      expect(
        await purgeRealtimeEvents(t.db, new Date(t.clock.now().getTime() + 24 * 3600_000)),
      ).toBeGreaterThanOrEqual(3)
      const latest = await pub('after-purge')
      await startApi()
      const resync = await client.waitFor((f) => f.event === 'resync')
      expect(resync.data).toEqual({ reason: 'cursor_expired', latestId: latest })
      // after the resync the client refetches and carries on from the latest id; new events still stream live
      const live = await pub('live')
      await client.waitFor((f) => f.id === String(live))
      expect(client.messages.map((f) => (f.data as { type: string }).type)).toEqual(['seen', 'live'])
    } finally {
      await client.stop()
    }
  }, 180_000)

  it('sends resync after a replay that is too large for the buffer', async () => {
    await startApi()
    const loc = await locationId()
    const cursor = await pub('cursor')
    await sql`insert into realtime_events (location_id, channel, type, payload)
      select ${loc}, 'ops', 'bulk', '{}'::jsonb from generate_series(1, 5200)`.execute(t.db)
    const c = await openSse(`${BASE}/api/v1/events`, { 'Last-Event-ID': String(cursor) })
    try {
      const resync = await c.waitFor((f) => f.event === 'resync', 60_000)
      expect(resync.data).toMatchObject({ reason: 'replay_too_large' })
    } finally {
      c.close()
    }
  }, 120_000)

  it('reports the queue and database state on /healthz and /readyz, and the jobs on /system/jobs, from the running process', async () => {
    await startApi()
    const health = (await (await fetch(`${BASE}/healthz`)).json()) as {
      status: string
      checks: { db: unknown; jobs: unknown }
    }
    expect(health.status).toBe('ok')
    expect(health.checks.db).toEqual({ ok: true, detail: 'ok' })
    expect(health.checks.jobs).toMatchObject({
      ok: true,
      queue: { queued: expect.any(Number), failed: 0, deadLetter: 0 },
    })
    const ready = await fetch(`${BASE}/readyz`)
    expect(ready.status).toBe(200)
    expect((await ready.json()) as Record<string, unknown>).toMatchObject({
      status: 'ready',
      checks: { db: { ok: true }, jobs: { ok: true } },
    })
    const jobs = await fetch(`${BASE}/api/v1/system/jobs`)
    expect(jobs.status).toBe(200)
    const body = (await jobs.json()) as {
      enabled: boolean
      jobs: Array<{ name: string }>
      worker: { state: string }
    }
    expect(body.enabled).toBe(true)
    expect(body.jobs.map((j) => j.name)).toContain('appointments.reminders')
    expect(body.worker.state).toBe('unknown') // no worker has run against this schema
    expect(apiOutput).not.toMatch(/\+1305\d{7}/)
  }, 120_000)
})
