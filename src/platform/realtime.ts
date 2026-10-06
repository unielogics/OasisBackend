// Realtime: publish(tx, ...) writes a durable realtime_events row in the caller's transaction (a trigger NOTIFYs on
// commit). A RealtimeHub owns ONE dedicated LISTEN connection, loads new rows and fans them out to SSE subscribers.
import { sql } from 'kysely'
import type pg from 'pg'
import { connectDedicated, type DbOptions, type Executor, type Db, type Tx } from './db.js'
import type { JsonValue } from './schema.js'

export const REALTIME_CHANNELS = ['ops', 'payments', 'messages', 'settings', 'notifications'] as const
export type RealtimeChannel = (typeof REALTIME_CHANNELS)[number]

export const isRealtimeChannel = (s: string): s is RealtimeChannel =>
  (REALTIME_CHANNELS as readonly string[]).includes(s)

/**
 * Permission needed to receive a channel. null = any signed-in user; 'self' = only events targeted at that user
 * (publish with targetUserId). The Authorizer can override per channel (canSubscribe).
 */
export const CHANNEL_PERMISSION: Record<RealtimeChannel, string | null | 'self'> = {
  ops: 'sched.view',
  payments: 'pay.reports',
  messages: 'cli.view',
  settings: null,
  notifications: 'self',
}

export interface RealtimeEvent {
  id: number
  at: Date
  locationId: string
  channel: string
  type: string
  payload: Record<string, JsonValue>
  targetUserId: string | null
}

export interface PublishInput {
  locationId: string
  channel: RealtimeChannel
  type: string
  payload?: Record<string, JsonValue>
  /** Deliver only to this user (notifications channel). */
  targetUserId?: string | null
}

/** Inserts the event in the caller's transaction; subscribers are woken when it commits. */
export async function publish(tx: Tx, e: PublishInput): Promise<number> {
  const row = await tx
    .insertInto('realtime_events')
    .values({
      location_id: e.locationId,
      channel: e.channel,
      type: e.type,
      payload: JSON.stringify(e.payload ?? {}),
      target_user_id: e.targetUserId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

type EventRow = {
  id: number
  at: Date
  location_id: string
  channel: string
  type: string
  payload: Record<string, JsonValue>
  target_user_id: string | null
}

const toEvent = (r: EventRow): RealtimeEvent => ({
  id: r.id,
  at: r.at,
  locationId: r.location_id,
  channel: r.channel,
  type: r.type,
  payload: r.payload,
  targetUserId: r.target_user_id,
})

export async function fetchEventsAfter(
  db: Executor,
  q: { afterId: number; limit?: number; locationId?: string },
): Promise<RealtimeEvent[]> {
  let sel = db
    .selectFrom('realtime_events')
    .selectAll()
    .where('id', '>', q.afterId)
    .orderBy('id', 'asc')
    .limit(q.limit ?? 1000)
  if (q.locationId) sel = sel.where('location_id', '=', q.locationId)
  return (await sel.execute()).map((r) => toEvent(r as EventRow))
}

export interface CursorState {
  latestId: number
  purgedThrough: number
}

export async function cursorState(db: Executor): Promise<CursorState> {
  const r = await sql<{ latest: number | null; purged: number | null }>`
    select pg_sequence_last_value(pg_get_serial_sequence('realtime_events', 'id')::regclass)::bigint as latest,
           (select purged_through from realtime_state where id) as purged`.execute(db)
  const row = r.rows[0]
  return { latestId: row?.latest ?? 0, purgedThrough: row?.purged ?? 0 }
}

/**
 * True when events after `lastEventId` can no longer be replayed faithfully: they were purged, or the cursor is ahead
 * of the sequence (database restored or reset). The client must refetch everything.
 */
export function needsResync(lastEventId: number, s: CursorState): boolean {
  return lastEventId < s.purgedThrough || lastEventId > s.latestId
}

export async function purgeRealtimeEvents(db: Db, olderThan: Date): Promise<number> {
  const r = await sql<{ n: number }>`select realtime_purge(${olderThan}) as n`.execute(db)
  return Number(r.rows[0]?.n ?? 0)
}

export interface Subscriber {
  locationId: string
  userId: string | null
  channels: ReadonlySet<string>
  onEvent(e: RealtimeEvent): void
  onClose(): void
}

export interface HubLogger {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
  debug?(obj: unknown, msg?: string): void
}

export interface HubOptions {
  db: Db
  connection: DbOptions
  logger?: HubLogger
  /** Safety-net poll in case a NOTIFY is missed; also drives catch-up after a reconnect. */
  pollMs?: number
}

const WINDOW = 256

export class RealtimeHub {
  private subs = new Set<Subscriber>()
  private client: pg.Client | null = null
  private lastId = 0
  private seen = new Set<number>()
  private pumping = false
  private again = false
  private closed = false
  private poll: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  private backoff = 500
  private channelName = 'oasis_rt'
  private readonly log: HubLogger

  constructor(private readonly o: HubOptions) {
    this.log = o.logger ?? { warn: () => undefined, error: () => undefined }
  }

  get latestSeenId(): number {
    return this.lastId
  }

  get subscriberCount(): number {
    return this.subs.size
  }

  async start(): Promise<void> {
    this.lastId = (await cursorState(this.o.db)).latestId
    const name = await sql<{ n: string }>`select realtime_channel_name() as n`.execute(this.o.db)
    this.channelName = name.rows[0]!.n
    await this.connect()
    const pollMs = this.o.pollMs ?? 5000
    this.poll = setInterval(() => void this.pump(), pollMs)
    this.poll.unref()
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    const client = await connectDedicated(this.o.connection)
    client.on('notification', () => void this.pump())
    const lost = (err?: Error): void => {
      if (this.client !== client) return
      this.client = null
      client.removeAllListeners()
      client.end().catch(() => undefined)
      if (err) this.log.warn({ err: err.message }, 'realtime LISTEN connection lost')
      this.scheduleReconnect()
    }
    client.on('error', lost)
    client.on('end', () => lost())
    await client.query(`LISTEN "${this.channelName}"`)
    this.client = client
    this.backoff = 500
    await this.pump() // catch up on anything committed while disconnected
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect().catch((e: Error) => {
        this.log.warn({ err: e.message }, 'realtime reconnect failed')
        this.backoff = Math.min(this.backoff * 2, 30_000)
        this.scheduleReconnect()
      })
    }, this.backoff)
    this.retry.unref()
  }

  /**
   * Loads events newer than the last delivered id (re-reading a small window so a transaction that committed out of
   * id order is still delivered) and fans them out. Coalesces concurrent wake-ups.
   */
  async pump(): Promise<void> {
    if (this.closed) return
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = true
    try {
      do {
        this.again = false
        const rows = await fetchEventsAfter(this.o.db, { afterId: Math.max(0, this.lastId - WINDOW) })
        for (const e of rows) {
          if (this.seen.has(e.id)) continue
          this.seen.add(e.id)
          if (e.id > this.lastId) this.lastId = e.id
          this.dispatch(e)
        }
        for (const id of this.seen) if (id < this.lastId - WINDOW * 2) this.seen.delete(id)
      } while (this.again && !this.closed)
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'realtime pump failed')
    } finally {
      this.pumping = false
    }
  }

  private dispatch(e: RealtimeEvent): void {
    for (const s of this.subs) {
      if (s.locationId !== e.locationId || !s.channels.has(e.channel)) continue
      if (e.targetUserId && e.targetUserId !== s.userId) continue
      try {
        s.onEvent(e)
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'realtime subscriber threw')
      }
    }
  }

  subscribe(s: Subscriber): () => void {
    this.subs.add(s)
    return () => {
      this.subs.delete(s)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.poll) clearInterval(this.poll)
    if (this.retry) clearTimeout(this.retry)
    for (const s of [...this.subs]) {
      this.subs.delete(s)
      s.onClose()
    }
    const c = this.client
    this.client = null
    if (c) {
      c.removeAllListeners()
      await c.end().catch(() => undefined)
    }
  }
}
