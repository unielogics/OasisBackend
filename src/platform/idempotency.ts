// Idempotency-Key support. The key is claimed in its own committed statement (state in_flight), the command runs in one
// transaction, and the stored response is written inside that same transaction, so a committed mutation always has its
// replayable response. Failures release the key so the client can retry (the transaction rolled back, nothing happened).
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import type { Clock } from './clock.js'
import type { Db, Tx } from './db.js'
import { AppError } from './errors.js'

export const IDEMPOTENCY_TTL_MS = 48 * 3600 * 1000
/** An in-flight claim older than this is treated as abandoned by a crashed process and may be reclaimed. */
export const IN_FLIGHT_TIMEOUT_MS = 120_000
export const IDEMPOTENCY_HEADER = 'idempotency-key'

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/

export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key)) throw new AppError('IDEMPOTENCY_KEY_INVALID')
}

/** JSON with sorted object keys, so equal bodies hash equally regardless of key order. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

function normalisedUrl(url: string): string {
  const i = url.indexOf('?')
  if (i < 0) return url
  const q = new URLSearchParams(url.slice(i + 1))
  q.sort()
  const s = q.toString()
  return s ? `${url.slice(0, i)}?${s}` : url.slice(0, i)
}

/** sha256 of method + path (+ sorted query) + canonical body. */
export function requestHash(r: { method: string; url: string; body: unknown }): string {
  return createHash('sha256')
    .update(`${r.method.toUpperCase()} ${normalisedUrl(r.url)}\n${canonicalJson(r.body)}`)
    .digest('hex')
}

export interface IdempotentRequest {
  key: string
  /** Who owns the key: the user id, so two users can never collide or replay each other's responses. */
  actor: string
  method: string
  /** Request URL as received (path and query). */
  url: string
  /** Route pattern (e.g. /api/v1/invoices/:id/refunds), stored for diagnostics. */
  route: string
  body: unknown
}

export interface IdempotentResult<T = unknown> {
  status: number
  body: T
  headers?: Record<string, string>
}

export interface IdempotentOutcome<T = unknown> extends IdempotentResult<T> {
  replayed: boolean
}

async function claim(db: Db, clock: Clock, r: IdempotentRequest, hash: string): Promise<boolean> {
  const now = clock.now()
  const lockUntil = new Date(now.getTime() + IN_FLIGHT_TIMEOUT_MS)
  const expires = new Date(now.getTime() + IDEMPOTENCY_TTL_MS)
  const res = await sql<{ key: string }>`
    insert into idempotency_keys (key, actor, method, route, request_hash, state, created_at, lock_expires_at, expires_at)
    values (${r.key}, ${r.actor}, ${r.method.toUpperCase()}, ${r.route}, ${hash}, 'in_flight', ${now}, ${lockUntil}, ${expires})
    on conflict (key, actor) do update set
      method = excluded.method, route = excluded.route, request_hash = excluded.request_hash, state = 'in_flight',
      response_status = null, response_body = null, response_headers = null,
      created_at = excluded.created_at, lock_expires_at = excluded.lock_expires_at, expires_at = excluded.expires_at
    where idempotency_keys.expires_at <= excluded.created_at
       or (idempotency_keys.state = 'in_flight' and idempotency_keys.lock_expires_at <= excluded.created_at)
    returning key`.execute(db)
  return res.rows.length === 1
}

/**
 * Claims the key, then runs `prepare` (when given) and the command. `prepare` runs once per executed command, after the claim and
 * before the transaction opens, on the pool's own autocommit statements: what it writes survives a failing command (a durable rate
 * limit charged there still counts), and it never holds a connection while the command's transaction holds another. Whatever it
 * throws releases the key like a failing command. A replay runs neither.
 */
export async function runIdempotent<T, P = undefined>(
  db: Db,
  clock: Clock,
  req: IdempotentRequest,
  fn: (tx: Tx, prepared: P) => Promise<IdempotentResult<T>>,
  prepare?: () => Promise<P>,
): Promise<IdempotentOutcome<T>> {
  assertValidKey(req.key)
  const hash = requestHash(req)

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await claim(db, clock, req, hash)) return execute(db, req, hash, fn, prepare)

    const existing = await db
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'state', 'response_status', 'response_body', 'response_headers'])
      .where('key', '=', req.key)
      .where('actor', '=', req.actor)
      .executeTakeFirst()
    if (!existing) continue // released between the claim and the read: try to claim again
    if (existing.request_hash !== hash) throw new AppError('IDEMPOTENCY_MISMATCH')
    if (existing.state === 'in_flight') {
      throw new AppError('IDEMPOTENCY_IN_FLIGHT', { headers: { 'Retry-After': '1' } })
    }
    return {
      replayed: true,
      status: existing.response_status ?? 200,
      body: existing.response_body as T,
      headers: existing.response_headers ?? undefined,
    }
  }
  throw new AppError('CONCURRENT_UPDATE')
}

async function execute<T, P>(
  db: Db,
  req: IdempotentRequest,
  hash: string,
  fn: (tx: Tx, prepared: P) => Promise<IdempotentResult<T>>,
  prepare: (() => Promise<P>) | undefined,
): Promise<IdempotentOutcome<T>> {
  try {
    const prepared = (prepare ? await prepare() : undefined) as P
    const result = await db.transaction().execute(async (tx) => {
      const out = await fn(tx, prepared)
      const done = await tx
        .updateTable('idempotency_keys')
        .set({
          state: 'done',
          response_status: out.status,
          response_body: out.body === undefined ? null : JSON.stringify(out.body),
          response_headers: out.headers ? JSON.stringify(out.headers) : null,
        })
        .where('key', '=', req.key)
        .where('actor', '=', req.actor)
        .where('request_hash', '=', hash)
        .where('state', '=', 'in_flight')
        .executeTakeFirst()
      // The claim was reclaimed as abandoned while this command ran; roll back rather than risk a double effect.
      if (Number(done.numUpdatedRows) !== 1) throw new AppError('CONCURRENT_UPDATE')
      return out
    })
    return { ...result, replayed: false }
  } catch (e) {
    await db
      .deleteFrom('idempotency_keys')
      .where('key', '=', req.key)
      .where('actor', '=', req.actor)
      .where('request_hash', '=', hash)
      .where('state', '=', 'in_flight')
      .execute()
      .catch(() => undefined)
    throw e
  }
}

export async function purgeExpiredKeys(db: Db, clock: Clock): Promise<number> {
  const r = await db.deleteFrom('idempotency_keys').where('expires_at', '<=', clock.now()).executeTakeFirst()
  return Number(r.numDeletedRows)
}
