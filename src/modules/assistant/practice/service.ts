// The practice chat's sessions and turns (ADR 0174 §4c; api-spec 15.6e): a session is its creator's own (another user's is 404),
// kept 30 days; a text becomes a `running` turn that job ai.practice answers. The switches and limits:
//   AI_PRACTICE_ENABLED            off: 409 PRACTICE_OFF (whatever AI_ENABLED says; practice never needs it)
//   AI_PRACTICE_DAILY_BUDGET_USD   the location's practice spend of the business day (its own: never counted in AI_DAILY_BUDGET_USD,
//                                  so practice cannot starve live replies): reached, 429 PRACTICE_BUDGET
//   one running turn a session     409 PRACTICE_BUSY (a turn still running after 5 minutes failed: `timeout`)
//   40 turns a session, 20 sessions a user a day   429 PRACTICE_LIMIT
//   a session whose client opted out               409 PRACTICE_ENDED
import { sql } from 'kysely'
import type { Env } from '../../../config/env.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type { NewId } from '../../../platform/ids.js'
import { getSetting } from '../../../platform/settings.js'
import { bizDayBounds, toBizDate } from '../../../platform/time.js'
import { emptyPracticeState, parsePracticeState } from './effects.js'
import type { PracticeBadge } from './runner.js'
import type { PracticePersona, PracticeTurnStatus } from './schema.js'
import '../../customers/schema.js'
import '../knowledge/schema.js'
import './schema.js'

export const MAX_TURNS_PER_SESSION = 40
export const MAX_SESSIONS_PER_DAY = 20
export const PRACTICE_KEEP_DAYS = 30
/** A turn still running after this long is failed (`timeout`): the job expires after 3 minutes. */
export const STUCK_TURN_MS = 5 * 60_000

export interface PracticeContext {
  locationId: string
  /** The users row of the caller (the session's owner). */
  userId: string
  now: Date
  newId: NewId
  env: Pick<Env, 'AI_PRACTICE_ENABLED' | 'AI_PRACTICE_DAILY_BUDGET_USD' | 'BUSINESS_TZ' | 'AI_ACTIONS_ENABLED' | 'PUBLIC_LINKS_ENABLED'>
}

export interface PracticeSessionView {
  id: string
  persona: PracticePersona
  client: { id: string; firstName: string | null } | null
  verified: boolean
  language: 'en' | 'es'
  includeEntryIds: string[]
  turns: number
  costMicros: number
  createdAt: string
  updatedAt: string
}

export interface PracticeTurnView {
  id: string
  sessionId: string
  seq: number
  rerunOf: string | null
  clientText: string
  status: PracticeTurnStatus
  replyText: string | null
  extraTexts: string[]
  badges: PracticeBadge[]
  error: string | null
  latencyMs: number | null
  startedAt: string
  finishedAt: string | null
}

export interface PracticeStatus {
  enabled: boolean
  budgetUsd: number
  spentTodayUsd: number
  actionsEnabled: boolean
  linksEnabled: boolean
}

const jsonArray = <T>(v: unknown): T[] => {
  const x = typeof v === 'string' ? (JSON.parse(v) as unknown) : v
  return Array.isArray(x) ? (x as T[]) : []
}

const firstNameOf = (full: string | null | undefined): string | null => {
  if (!full || /^New texter\b/.test(full)) return null
  return full.trim().split(/\s+/)[0] ?? null
}

const SESSION_COLUMNS = ['s.id', 's.persona', 's.customer_id', 's.verified', 's.language', 's.include_entry_ids', 's.turns', 's.cost_micros', 's.created_at', 's.updated_at', 'c.full_name'] as const

type SessionRow = {
  id: string
  persona: PracticePersona
  customer_id: string | null
  verified: boolean
  language: 'en' | 'es'
  include_entry_ids: string[]
  turns: number
  cost_micros: number
  created_at: Date
  updated_at: Date
  full_name: string | null
}

const sessionView = (r: SessionRow): PracticeSessionView => ({
  id: r.id,
  persona: r.persona,
  client: r.customer_id ? { id: r.customer_id, firstName: firstNameOf(r.full_name) } : null,
  verified: r.verified,
  language: r.language,
  includeEntryIds: r.include_entry_ids ?? [],
  turns: r.turns,
  costMicros: Number(r.cost_micros),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
})

const TURN_COLUMNS = ['id', 'session_id', 'seq', 'rerun_of', 'client_text', 'status', 'reply_text', 'extra_texts', 'badges', 'error', 'latency_ms', 'started_at', 'finished_at'] as const

type TurnViewRow = {
  id: string
  session_id: string
  seq: number
  rerun_of: string | null
  client_text: string
  status: PracticeTurnStatus
  reply_text: string | null
  extra_texts: unknown
  badges: unknown
  error: string | null
  latency_ms: number | null
  started_at: Date
  finished_at: Date | null
}

export const turnView = (r: TurnViewRow): PracticeTurnView => ({
  id: r.id,
  sessionId: r.session_id,
  seq: r.seq,
  rerunOf: r.rerun_of,
  clientText: r.client_text,
  status: r.status,
  replyText: r.reply_text,
  extraTexts: jsonArray<string>(r.extra_texts),
  badges: jsonArray<PracticeBadge>(r.badges),
  error: r.error,
  latencyMs: r.latency_ms,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
})

/** The location's practice spend of the business day, in USD millionths. */
export async function practiceSpentToday(db: Executor, o: { locationId: string; now: Date; tz: string }): Promise<number> {
  const start = bizDayBounds(toBizDate(o.now, o.tz), o.tz).start
  const r = await sql<{ n: string | number }>`
    select coalesce(sum(t.cost_micros), 0) as n from assistant_practice_turns t
    join assistant_practice_sessions s on s.id = t.session_id
    where s.location_id = ${o.locationId} and t.started_at >= ${start}`.execute(db)
  return Number(r.rows[0]?.n ?? 0)
}

export async function practiceStatus(db: Executor, c: Pick<PracticeContext, 'locationId' | 'now' | 'env'>): Promise<PracticeStatus> {
  const spent = await practiceSpentToday(db, { locationId: c.locationId, now: c.now, tz: c.env.BUSINESS_TZ })
  return {
    enabled: c.env.AI_PRACTICE_ENABLED,
    budgetUsd: c.env.AI_PRACTICE_DAILY_BUDGET_USD,
    spentTodayUsd: Math.round(spent) / 1e6,
    actionsEnabled: c.env.AI_ACTIONS_ENABLED && (await getSetting(db, c.locationId, 'assistant.actions_enabled')).value,
    linksEnabled: c.env.PUBLIC_LINKS_ENABLED,
  }
}

const assertOn = (c: PracticeContext): void => {
  if (!c.env.AI_PRACTICE_ENABLED) throw new AppError('PRACTICE_OFF')
}

async function assertBudgetLeft(db: Executor, c: PracticeContext): Promise<void> {
  const spent = await practiceSpentToday(db, { locationId: c.locationId, now: c.now, tz: c.env.BUSINESS_TZ })
  if (spent >= Math.round(c.env.AI_PRACTICE_DAILY_BUDGET_USD * 1e6))
    throw new AppError('PRACTICE_BUDGET', { meta: { budgetUsd: c.env.AI_PRACTICE_DAILY_BUDGET_USD, spentTodayUsd: Math.round(spent) / 1e6 } })
}

export interface NewSessionInput {
  persona: PracticePersona
  customerId?: string | null
  verified?: boolean
  language?: 'en' | 'es'
  includeEntryIds?: string[]
}

/** A fictional US number of the 555-01xx range (never a real phone): the synthetic new texter's. */
const fictionalNumber = (id: string): string => `+1201555${String(100 + (parseInt(id.replace(/-/g, '').slice(-4), 16) % 100)).padStart(4, '0')}`

/** A new practice session (the persona `client` needs cli.view: the route checks it). */
export async function createSession(tx: Tx, c: PracticeContext, input: NewSessionInput): Promise<PracticeSessionView> {
  assertOn(c)
  const dayStart = bizDayBounds(toBizDate(c.now, c.env.BUSINESS_TZ), c.env.BUSINESS_TZ).start
  const today = await tx
    .selectFrom('assistant_practice_sessions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', c.userId)
    .where('created_at', '>=', dayStart)
    .executeTakeFirstOrThrow()
  if (Number(today.n) >= MAX_SESSIONS_PER_DAY) throw new AppError('PRACTICE_LIMIT', { meta: { limit: 'sessions_per_day', max: MAX_SESSIONS_PER_DAY } })
  let customerId: string | null = null
  if (input.persona === 'client') {
    if (!input.customerId) throw new AppError('VALIDATION_FAILED', { detail: 'Pick the client to play', errors: [{ path: 'customerId', message: 'Pick the client to play.' }] })
    const client = await tx
      .selectFrom('customers')
      .select('id')
      .where('id', '=', input.customerId)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!client) throw new AppError('NOT_FOUND', { detail: 'That client does not exist' })
    customerId = client.id
  }
  const include = [...new Set(input.includeEntryIds ?? [])]
  if (include.length > 0) {
    const found = await tx.selectFrom('assistant_knowledge').select('id').where('location_id', '=', c.locationId).where('id', 'in', include).execute()
    if (found.length !== include.length)
      throw new AppError('VALIDATION_FAILED', { detail: 'A knowledge entry to try does not exist', errors: [{ path: 'includeEntryIds', message: 'A knowledge entry to try does not exist.' }] })
  }
  const id = c.newId()
  const state = emptyPracticeState()
  if (input.persona === 'new_texter') {
    const synthetic = c.newId()
    state.persona = { customerId: synthetic, phone: fictionalNumber(synthetic) }
  }
  const row = await tx
    .insertInto('assistant_practice_sessions')
    .values({
      id,
      location_id: c.locationId,
      user_id: c.userId,
      persona: input.persona,
      customer_id: customerId,
      verified: input.verified === true,
      include_entry_ids: include,
      language: input.language ?? 'en',
      state: JSON.stringify(state),
      created_at: c.now,
      updated_at: c.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return (await findSession(tx, c, row.id))!
}

async function findSession(db: Executor, c: Pick<PracticeContext, 'locationId' | 'userId' | 'now'>, id: string): Promise<PracticeSessionView | null> {
  const r = await db
    .selectFrom('assistant_practice_sessions as s')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .select([...SESSION_COLUMNS])
    .where('s.id', '=', id)
    .where('s.location_id', '=', c.locationId)
    .where('s.user_id', '=', c.userId)
    .where('s.created_at', '>', keepSince(c.now))
    .executeTakeFirst()
  return r ? sessionView(r as SessionRow) : null
}

const keepSince = (now: Date): Date => new Date(now.getTime() - PRACTICE_KEEP_DAYS * 86_400_000)

/** The caller's sessions of the last 30 days, newest first. */
export async function listSessions(db: Executor, c: Pick<PracticeContext, 'locationId' | 'userId' | 'now'>): Promise<PracticeSessionView[]> {
  const rows = await db
    .selectFrom('assistant_practice_sessions as s')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .select([...SESSION_COLUMNS])
    .where('s.location_id', '=', c.locationId)
    .where('s.user_id', '=', c.userId)
    .where('s.created_at', '>', keepSince(c.now))
    .orderBy('s.created_at', 'desc')
    .orderBy('s.id', 'desc')
    .limit(100)
    .execute()
  return rows.map((r) => sessionView(r as SessionRow))
}

/** One of the caller's sessions with its turns (another user's, or one past 30 days: 404). */
export async function getSession(db: Executor, c: Pick<PracticeContext, 'locationId' | 'userId' | 'now'>, id: string): Promise<{ session: PracticeSessionView; turns: PracticeTurnView[] }> {
  const session = await findSession(db, c, id)
  if (!session) throw new AppError('NOT_FOUND', { detail: 'That practice chat does not exist' })
  const turns = await db.selectFrom('assistant_practice_turns').select([...TURN_COLUMNS]).where('session_id', '=', id).orderBy('seq').orderBy('started_at').orderBy('id').execute()
  return { session, turns: turns.map((t) => turnView(t as TurnViewRow)) }
}

export async function deleteSession(tx: Tx, c: Pick<PracticeContext, 'locationId' | 'userId' | 'now'>, id: string): Promise<void> {
  const r = await tx.deleteFrom('assistant_practice_sessions').where('id', '=', id).where('location_id', '=', c.locationId).where('user_id', '=', c.userId).returning('id').executeTakeFirst()
  if (!r) throw new AppError('NOT_FOUND', { detail: 'That practice chat does not exist' })
}

/** Fails a turn of the session still running past STUCK_TURN_MS (a job that died), so the session is not busy forever. */
async function failStuck(tx: Tx, sessionId: string, now: Date): Promise<void> {
  await tx
    .updateTable('assistant_practice_turns')
    .set({ status: 'failed', error: 'timeout', finished_at: now })
    .where('session_id', '=', sessionId)
    .where('status', '=', 'running')
    .where('started_at', '<', new Date(now.getTime() - STUCK_TURN_MS))
    .execute()
}

async function lockedSession(tx: Tx, c: PracticeContext, id: string) {
  const s = await tx
    .selectFrom('assistant_practice_sessions')
    .select(['id', 'state', 'turns'])
    .where('id', '=', id)
    .where('location_id', '=', c.locationId)
    .where('user_id', '=', c.userId)
    .where('created_at', '>', keepSince(c.now))
    .forUpdate()
    .executeTakeFirst()
  if (!s) throw new AppError('NOT_FOUND', { detail: 'That practice chat does not exist' })
  return s
}

async function assertNotBusy(tx: Tx, sessionId: string, now: Date): Promise<void> {
  await failStuck(tx, sessionId, now)
  const running = await tx.selectFrom('assistant_practice_turns').select('id').where('session_id', '=', sessionId).where('status', '=', 'running').executeTakeFirst()
  if (running) throw new AppError('PRACTICE_BUSY')
}

/** A text in a practice session: a `running` turn the job answers (the caller enqueues ai.practice after the commit). */
export async function createTurn(tx: Tx, c: PracticeContext, sessionId: string, text: string): Promise<PracticeTurnView> {
  assertOn(c)
  const s = await lockedSession(tx, c, sessionId)
  if (parsePracticeState(s.state).optedOut) throw new AppError('PRACTICE_ENDED')
  await assertNotBusy(tx, s.id, c.now)
  if (s.turns >= MAX_TURNS_PER_SESSION) throw new AppError('PRACTICE_LIMIT', { meta: { limit: 'turns_per_session', max: MAX_TURNS_PER_SESSION } })
  await assertBudgetLeft(tx, c)
  const last = await tx
    .selectFrom('assistant_practice_turns')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('session_id', '=', s.id)
    .where('rerun_of', 'is', null)
    .executeTakeFirst()
  const row = await tx
    .insertInto('assistant_practice_turns')
    .values({
      id: c.newId(),
      session_id: s.id,
      seq: (last?.seq ?? 0) + 1,
      rerun_of: null,
      client_text: text.trim(),
      state_before: JSON.stringify(parsePracticeState(s.state)),
      started_at: c.now,
    })
    .returning([...TURN_COLUMNS])
    .executeTakeFirstOrThrow()
  await tx.updateTable('assistant_practice_sessions').set({ turns: s.turns + 1, updated_at: c.now }).where('id', '=', s.id).execute()
  return turnView(row as TurnViewRow)
}

/**
 * "Try again" (design §5): the same client text over the session's earlier turns, from the state the original began with, as an
 * alternate turn (`rerunOf`; after a correction the facts hold it). A re-run of a re-run re-runs the original.
 */
export async function rerunTurn(tx: Tx, c: PracticeContext, turnId: string): Promise<PracticeTurnView> {
  assertOn(c)
  const t = await tx
    .selectFrom('assistant_practice_turns as t')
    .innerJoin('assistant_practice_sessions as s', 's.id', 't.session_id')
    .select(['t.id', 't.rerun_of', 't.session_id'])
    .where('t.id', '=', turnId)
    .where('s.location_id', '=', c.locationId)
    .where('s.user_id', '=', c.userId)
    .executeTakeFirst()
  if (!t) throw new AppError('NOT_FOUND', { detail: 'That practice text does not exist' })
  const s = await lockedSession(tx, c, t.session_id)
  const original = await tx
    .selectFrom('assistant_practice_turns')
    .select(['id', 'seq', 'client_text', 'state_before'])
    .where('id', '=', t.rerun_of ?? t.id)
    .executeTakeFirstOrThrow()
  await assertNotBusy(tx, s.id, c.now)
  if (s.turns >= MAX_TURNS_PER_SESSION) throw new AppError('PRACTICE_LIMIT', { meta: { limit: 'turns_per_session', max: MAX_TURNS_PER_SESSION } })
  await assertBudgetLeft(tx, c)
  const row = await tx
    .insertInto('assistant_practice_turns')
    .values({
      id: c.newId(),
      session_id: s.id,
      seq: original.seq,
      rerun_of: original.id,
      client_text: original.client_text,
      state_before: JSON.stringify(original.state_before ?? {}),
      started_at: c.now,
    })
    .returning([...TURN_COLUMNS])
    .executeTakeFirstOrThrow()
  await tx.updateTable('assistant_practice_sessions').set({ turns: s.turns + 1, updated_at: c.now }).where('id', '=', s.id).execute()
  return turnView(row as TurnViewRow)
}

/** Fails a turn whose job could not be queued (the caller's enqueue failed after the commit). */
export async function failTurn(db: Executor, turnId: string, now: Date, error: string): Promise<void> {
  await db.updateTable('assistant_practice_turns').set({ status: 'failed', error, finished_at: now }).where('id', '=', turnId).where('status', '=', 'running').execute()
}

/** assistant.practice.retention: sessions older than 30 days go (their turns with them); turns stuck running are failed. */
export async function purgePractice(db: Executor, now: Date): Promise<{ sessions: number; stuck: number }> {
  const stuck = await db
    .updateTable('assistant_practice_turns')
    .set({ status: 'failed', error: 'timeout', finished_at: now })
    .where('status', '=', 'running')
    .where('started_at', '<', new Date(now.getTime() - STUCK_TURN_MS))
    .returning('id')
    .execute()
  const gone = await db.deleteFrom('assistant_practice_sessions').where('created_at', '<=', keepSince(now)).returning('id').execute()
  return { sessions: gone.length, stuck: stuck.length }
}
