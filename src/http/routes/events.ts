// GET /api/v1/events: Server-Sent Events over the realtime_events log.
//   - default (unnamed) messages carry one event: { channel, type, payload, at } with `id: <realtime_events.id>`
//   - `ready`  (named) first on every connection: { channels, denied, cursor, heartbeatMs }; carries an id only on fresh
//     connections so a drop mid-replay never advances the cursor past unreplayed events
//   - `resync` (named) when the Last-Event-ID can no longer be replayed (purged or ahead of the log): refetch everything
//   - `: hb` comment every SSE_HEARTBEAT_MS keeps proxies from closing an idle stream
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { AppError } from '../../platform/errors.js'
import {
  CHANNEL_PERMISSION,
  REALTIME_CHANNELS,
  cursorState,
  fetchEventsAfter,
  isRealtimeChannel,
  needsResync,
  type RealtimeChannel,
  type RealtimeEvent,
} from '../../platform/realtime.js'
import { access } from '../access.js'
import { hasPermission, type AuthContext } from '../authorizer.js'
import { z } from '../zod.js'
import type { AppInstance } from '../types.js'

const MAX_STREAMS_PER_USER = 8
const MAX_REPLAY = 5000
const MAX_BUFFERED_BYTES = 1024 * 1024
/** How often an open stream re-validates its session and channel permissions. */
const RECHECK_MS = 15_000

function frame(f: { id?: number; event?: string; data?: unknown; comment?: string; retry?: number }): string {
  let out = ''
  if (f.comment !== undefined) out += `: ${f.comment}\n`
  if (f.retry !== undefined) out += `retry: ${f.retry}\n`
  if (f.id !== undefined) out += `id: ${f.id}\n`
  if (f.event) out += `event: ${f.event}\n`
  if (f.data !== undefined) out += `data: ${JSON.stringify(f.data)}\n`
  return `${out}\n`
}

/** Ends the response and drops the socket once flushed so a keep-alive connection cannot delay server shutdown. */
function endStream(res: ServerResponse): void {
  if (res.writableEnded) return
  res.end(() => res.socket?.destroy())
}

const eventData = (e: RealtimeEvent): unknown => ({
  channel: e.channel,
  type: e.type,
  payload: e.payload,
  at: e.at.toISOString(),
})

function canSubscribe(app: AppInstance, ctx: AuthContext, channel: RealtimeChannel): boolean {
  if (app.authorizer.canSubscribe) return app.authorizer.canSubscribe(ctx, channel)
  const need = CHANNEL_PERMISSION[channel]
  return need === null || need === 'self' || hasPermission(ctx, need)
}

export function registerEventsRoute(app: AppInstance): void {
  const open = new Set<ServerResponse>()
  const perUser = new Map<string, number>()

  app.addHook('onClose', async () => {
    for (const res of open) endStream(res)
    open.clear()
  })

  app.get(
    '/events',
    {
      config: { access: access.authenticated(), rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['realtime'],
        summary: 'Server-Sent Events stream (text/event-stream)',
        description:
          'Query `channels` (comma separated: ops, payments, messages, settings, notifications; default all permitted). ' +
          'Resume with the `Last-Event-ID` header (or `lastEventId`). Channels the caller lacks permission for are dropped and listed in `ready.denied`.',
        querystring: z.object({ channels: z.string().optional(), lastEventId: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const hub = app.hub
      if (!hub) throw new AppError('SERVICE_UNAVAILABLE', { detail: 'Realtime is not available' })
      const ctx = req.auth!

      const requested = req.query.channels
        ? [
            ...new Set(
              req.query.channels
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ]
        : [...REALTIME_CHANNELS]
      const unknown = requested.filter((c) => !isRealtimeChannel(c))
      if (unknown.length) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `Unknown channel: ${unknown.join(', ')}`,
          errors: [{ path: 'query.channels', message: `Unknown channel: ${unknown.join(', ')}` }],
        })
      }
      const wanted = requested as RealtimeChannel[]
      const allowed = wanted.filter((c) => canSubscribe(app, ctx, c))
      const denied = wanted.filter((c) => !allowed.includes(c))

      const count = perUser.get(ctx.userId) ?? 0
      if (count >= MAX_STREAMS_PER_USER) {
        throw new AppError('RATE_LIMITED', { detail: 'Too many open event streams for this user' })
      }

      const header = req.headers['last-event-id']
      const rawLast = (typeof header === 'string' && header !== '' ? header : req.query.lastEventId) ?? ''
      const resuming = rawLast !== ''
      const lastId = /^\d+$/.test(rawLast) ? Number(rawLast) : Number.NaN

      perUser.set(ctx.userId, count + 1)
      reply.hijack()
      const res = reply.raw
      open.add(res)
      const inherited = { ...(reply.getHeaders() as OutgoingHttpHeaders) }
      delete inherited['content-length']
      res.writeHead(200, {
        ...inherited,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(frame({ retry: 3000 }))

      let live = false
      let closed = false
      const buffer: RealtimeEvent[] = []
      const replayed = new Set<number>()
      // events at or below this id are never sent live: they predate a fresh stream or were replayed to a resumed one (the hub can
      // dispatch them late, after the stream went live)
      let floor = Number.MAX_SAFE_INTEGER
      const channels = new Set<string>(allowed)

      const write = (chunk: string): void => {
        if (closed) return
        res.write(chunk)
        if (res.writableLength > MAX_BUFFERED_BYTES) cleanup() // slow consumer: it reconnects with Last-Event-ID
      }
      const send = (e: RealtimeEvent): void => write(frame({ id: e.id, data: eventData(e) }))

      const heartbeat = setInterval(() => write(frame({ comment: 'hb' })), app.env.SSE_HEARTBEAT_MS)

      // The stream was authorised once, at connect. Re-check the session and the permissions behind each channel on a timer and
      // whenever access changes anywhere (rbac.changed), so a sign-out, deactivation, expiry or demotion ends or narrows it.
      let rechecking = false
      const recheck = async (): Promise<void> => {
        if (closed || rechecking) return
        rechecking = true
        try {
          const now = await app.authorizer.resolve(req, { touch: false })
          if (closed) return
          if (!now) return cleanup()
          for (const c of [...channels]) if (!canSubscribe(app, now, c as RealtimeChannel)) channels.delete(c)
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'event stream re-check failed; keeping the stream')
        } finally {
          rechecking = false
        }
      }
      const recheckTimer = setInterval(() => void recheck(), Math.min(app.env.SSE_HEARTBEAT_MS, RECHECK_MS))
      const unsubscribe = hub.subscribe({
        locationId: ctx.locationId,
        userId: ctx.userId,
        channels,
        onEvent: (e) => {
          if (e.type === 'rbac.changed') void recheck()
          if (!live) buffer.push(e)
          // the hub may dispatch an event the replay query already sent (it reads the log slightly behind the commit)
          else if (!replayed.delete(e.id) && e.id > floor) send(e)
        },
        onClose: () => cleanup(),
      })

      function cleanup(): void {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        clearInterval(recheckTimer)
        unsubscribe()
        open.delete(res)
        const n = (perUser.get(ctx.userId) ?? 1) - 1
        if (n <= 0) perUser.delete(ctx.userId)
        else perUser.set(ctx.userId, n)
        endStream(res)
      }
      req.raw.on('close', cleanup)
      res.on('close', cleanup)
      // A client that left while authentication ran has already emitted its 'close': nothing would ever end this stream
      // or give its slot back, and eight of those lock the person out of realtime until the process restarts.
      if (res.destroyed || !res.socket || res.socket.destroyed) {
        cleanup()
        return reply
      }

      try {
        const state = await cursorState(app.db)
        const readyBody = {
          channels: allowed,
          denied,
          cursor: state.latestId,
          heartbeatMs: app.env.SSE_HEARTBEAT_MS,
        }
        floor = state.latestId

        if (!resuming) {
          write(frame({ event: 'ready', id: state.latestId, data: readyBody }))
        } else {
          write(frame({ event: 'ready', data: readyBody }))
          if (Number.isNaN(lastId) || needsResync(lastId, state)) {
            write(
              frame({
                event: 'resync',
                id: state.latestId,
                data: { reason: 'cursor_expired', latestId: state.latestId },
              }),
            )
          } else {
            floor = lastId
            let cursor = lastId
            let sent = 0
            for (;;) {
              const batch = await fetchEventsAfter(app.db, {
                afterId: cursor,
                locationId: ctx.locationId,
                limit: 1000,
              })
              if (batch.length === 0) break
              for (const e of batch) {
                cursor = e.id
                if (!channels.has(e.channel) || (e.targetUserId && e.targetUserId !== ctx.userId)) continue
                replayed.add(e.id)
                send(e)
                sent++
              }
              if (sent > MAX_REPLAY) {
                write(
                  frame({
                    event: 'resync',
                    id: state.latestId,
                    data: { reason: 'replay_too_large', latestId: state.latestId },
                  }),
                )
                break
              }
            }
          }
        }

        for (const e of buffer.splice(0)) if (e.id > floor && !replayed.has(e.id)) send(e)
        live = true
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'event stream setup failed')
        cleanup()
      }
      return reply
    },
  )
}
