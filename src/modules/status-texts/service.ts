// The status-texts port (ADR 0160, design section 6), called by lifecycle.finish() inside the transition's transaction:
//   arrived (manual)          queues the checked-in text: a pending_checkin_texts row due status_texts.checked_in_delay_min later,
//                             sent by the appointments.checkin_texts job (a geofence arrival already got its welcome text)
//   cleaning / completed      drops a pending checked-in text (the existing "wash started" text goes instead)
//   canceled / no_show        drops it too
//   pickup (collected)        the picked-up thank-you, at once (status_texts.picked_up), with the receipt line and, only with
//                             status_texts.book_again_link on, the link pages on (PUBLIC_LINKS_ENABLED) and marketing-grade
//                             consent, a personal book-again link
// The ready-for-pickup text stays where it was (lifecycle.completeAppointment, which reads status_texts.ready); running late is the
// appointments.late_texts job. Every text goes through DbMessageQueue.enqueueFor: the class policy decides consent, STOP and quiet
// hours, and a dedupe key per visit (status:<text>:<appointment>[:<seq>]) means a visit never gets the same status text twice.
//
// A status text never blocks the staff's transition: the port's work runs in a savepoint, and an unexpected error is rolled back to
// it and logged, so the arrival, the start or the pickup still commits.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { getSetting } from '../../platform/settings.js'
import { issueClientLink } from '../identity/links.js'
import type { CustomerTarget } from '../messaging/db/recipients.js'
import { hasMarketingConsent } from '../messaging/policy/canSend.js'
import type { EnqueueArgs, EnqueueOutcome, SkipReason } from '../messaging/queue.js'
import type { SchedulingCtx } from '../scheduling/context.js'
import type { StatusTextEvent, StatusTextsPort } from '../scheduling/ports.js'
import { pickedUpMessage, receiptLine, RECEIPT_TEXT_WINDOW_MS } from './compose.js'
import type { CheckinDropReason } from './schema.js'
import './schema.js'
import '../customers/schema.js'
import '../messaging/schema.js'

/** The part of the messaging queue the status texts use (DbMessageQueue). */
export interface StatusTextsQueue {
  enqueueFor(tx: Tx, a: EnqueueArgs): Promise<EnqueueOutcome>
  target(db: Executor, locationId: string, customerId: string): Promise<CustomerTarget | null>
}

export interface StatusTextsLog {
  error(obj: unknown, msg?: string): void
}

export interface StatusTextsDeps {
  queue: StatusTextsQueue
  /** PUBLIC_LINKS_ENABLED and PUBLIC_SITE_URL: a book-again link is only texted while the link pages answer. */
  links: { enabled: boolean; siteUrl?: string | undefined }
  log?: StatusTextsLog
}

/** Changes that settle a pending checked-in text, and how. */
const DROP_ON: Readonly<Record<string, CheckinDropReason>> = {
  cleaning: 'cleaning_started',
  completed: 'cleaning_started',
  canceled: 'canceled',
  no_show: 'canceled',
}

export const dedupeKeyOf = {
  checkedIn: (appointmentId: string): string => `status:checked_in:${appointmentId}`,
  runningLate: (appointmentId: string, seq: number): string => `status:running_late:${appointmentId}:${seq}`,
  pickedUp: (appointmentId: string): string => `status:picked_up:${appointmentId}`,
}

const SKIP_LABELS: Partial<Record<SkipReason, string>> = {
  opted_out: 'customer opted out of SMS',
  not_opted_in: 'customer has not opted in to SMS',
  no_valid_phone: 'no valid mobile number',
}

/** "Picked-up text sent", or "... not sent (customer opted out of SMS)". */
export function deliveryNote(text: string, out: EnqueueOutcome): string {
  if (out.queued) return `${text} sent`
  return `${text} not sent (${SKIP_LABELS[out.skipped] ?? out.skipped.replace(/_/g, ' ')})`
}

/** One automation line in the appointment's activity log (the status texts are the shop's, not a staff member's). */
export async function logStatusActivity(tx: Tx, appointmentId: string, at: Date, text: string, meta: Record<string, unknown> = {}): Promise<void> {
  await tx
    .insertInto('activity_log')
    .values({
      appointment_id: appointmentId,
      at,
      text,
      channels: ['sms'],
      actor_type: 'automation',
      actor_name: null,
      meta: JSON.stringify(meta) as never,
    })
    .execute()
}

/** Runs fn in a savepoint: on an error the savepoint is rolled back and the error returned, the transaction stays usable. */
export async function inSavepoint<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await sql.raw(`savepoint ${name}`).execute(tx)
  try {
    const value = await fn()
    await sql.raw(`release savepoint ${name}`).execute(tx)
    return { ok: true, value }
  } catch (error) {
    await sql.raw(`rollback to savepoint ${name}`).execute(tx)
    await sql.raw(`release savepoint ${name}`).execute(tx)
    return { ok: false, error }
  }
}

export function createStatusTexts(deps: StatusTextsDeps): StatusTextsPort {
  const guarded = async (tx: Tx, e: StatusTextEvent, fn: () => Promise<void>): Promise<void> => {
    const r = await inSavepoint(tx, 'status_texts', fn)
    if (!r.ok)
      deps.log?.error(
        { err: r.error instanceof Error ? r.error.message : String(r.error), appointmentId: e.appointmentId, change: e.change },
        'status text failed; the transition went ahead without it',
      )
  }
  return {
    async onChange(tx, c, e) {
      if (e.change === 'arrived') return guarded(tx, e, () => queueCheckedIn(tx, c, e.appointmentId))
      const drop = DROP_ON[e.change]
      if (drop) return guarded(tx, e, () => dropCheckedIn(tx, e.appointmentId, drop, c.clock.now()))
      if (e.change === 'pickup') return guarded(tx, e, () => pickedUp(tx, c, deps, e.appointmentId))
    },
  }
}

async function queueCheckedIn(tx: Tx, c: SchedulingCtx, appointmentId: string): Promise<void> {
  const a = await tx
    .selectFrom('appointments')
    .select(['id', 'status', 'arrived_at', 'geo_checked_in_at'])
    .where('id', '=', appointmentId)
    .executeTakeFirst()
  if (!a || a.status !== 'arrived' || !a.arrived_at) return
  // the geofence arrival sent its own welcome text (with the bay) at that moment
  if (a.geo_checked_in_at && a.geo_checked_in_at.getTime() === a.arrived_at.getTime()) return
  if (!(await getSetting(tx, c.locationId, 'status_texts.checked_in')).value) return
  const delayMin = (await getSetting(tx, c.locationId, 'status_texts.checked_in_delay_min')).value
  await tx
    .insertInto('pending_checkin_texts')
    .values({
      appointment_id: a.id,
      location_id: c.locationId,
      due_at: new Date(a.arrived_at.getTime() + delayMin * 60_000),
      created_at: c.clock.now(),
    })
    // one per visit: a visit reopened and arrived again keeps its first (settled) row, so it never gets a second checked-in text
    .onConflict((oc) => oc.column('appointment_id').doNothing())
    .execute()
}

export async function dropCheckedIn(tx: Tx, appointmentId: string, reason: CheckinDropReason, now: Date): Promise<void> {
  await tx
    .updateTable('pending_checkin_texts')
    .set({ state: 'dropped', drop_reason: reason, settled_at: now })
    .where('appointment_id', '=', appointmentId)
    .where('state', '=', 'pending')
    .execute()
}

/** The visit's invoice (the newest one not voided): total and balance from the ledger calc. */
async function invoiceOf(tx: Tx, appointmentId: string): Promise<{ totalCents: number; balanceCents: number } | null> {
  const r = await sql<{ total: string | number; balance: string | number }>`
    select c.total, c.balance
      from invoices i cross join lateral invoice_calc_of(i.id) c
     where i.appointment_id = ${appointmentId} and i.canceled_at is null
     order by i.created_at desc, i.id desc
     limit 1`.execute(tx)
  const row = r.rows[0]
  return row ? { totalCents: Number(row.total), balanceCents: Number(row.balance) } : null
}

/** Whether a receipt text went to the client since `since` (one that failed or expired does not count). */
async function receiptTextedSince(tx: Tx, customerId: string, since: Date): Promise<boolean> {
  const r = await tx
    .selectFrom('messages')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('direction', '=', 'out')
    .where('klass', '=', 'receipt')
    .where('queued_at', '>', since)
    .where('status', 'not in', ['failed', 'expired', 'canceled'])
    .limit(1)
    .executeTakeFirst()
  return r !== undefined
}

async function alreadyQueued(tx: Tx, dedupeKey: string): Promise<boolean> {
  return (await tx.selectFrom('messages').select('id').where('idempotency_key', '=', dedupeKey).executeTakeFirst()) !== undefined
}

class LinkTextNotQueued extends Error {
  constructor(readonly outcome: EnqueueOutcome) {
    super('the picked-up text with the book-again link was not queued')
  }
}

async function pickedUp(tx: Tx, c: SchedulingCtx, deps: StatusTextsDeps, appointmentId: string): Promise<void> {
  const a = await tx
    .selectFrom('appointments as a')
    .innerJoin('customers as cu', 'cu.id', 'a.customer_id')
    .select(['a.id', 'a.status', 'a.pickup_state', 'a.customer_id', 'cu.needs_details'])
    .where('a.id', '=', appointmentId)
    .executeTakeFirst()
  if (!a || a.status !== 'completed' || a.pickup_state !== 'collected') return
  if (!(await getSetting(tx, c.locationId, 'status_texts.picked_up')).value) return
  const dedupeKey = dedupeKeyOf.pickedUp(a.id)
  // picked up, reopened and picked up again: the first one stands (and no second book-again link is issued)
  if (await alreadyQueued(tx, dedupeKey)) return
  const target = await deps.queue.target(tx, c.locationId, a.customer_id)
  if (!target) return
  const now = c.clock.now()
  const receipt = receiptLine(await invoiceOf(tx, a.id), await receiptTextedSince(tx, a.customer_id, new Date(now.getTime() - RECEIPT_TEXT_WINDOW_MS)))
  // a placeholder name ("Walk-in guest", an assistant's "New texter ••1234") is never used as a first name
  const firstName = a.needs_details ? null : target.firstName
  const base = {
    locationId: c.locationId,
    customerId: a.customer_id,
    recipient: target.recipient,
    appointmentId: a.id,
    purpose: 'picked_up',
    senderKind: 'system' as const,
    dedupeKey,
  }

  let out: EnqueueOutcome | null = null
  let withLink = false
  const bookAgain =
    deps.links.enabled &&
    hasMarketingConsent(target.recipient) &&
    (await getSetting(tx, c.locationId, 'status_texts.book_again_link')).value
  if (bookAgain) {
    // the link exists only if its text was queued: the issue and the enqueue share a savepoint
    const r = await inSavepoint(tx, 'status_texts_link', async () => {
      const link = await issueClientLink(
        tx,
        { newId: c.newId, now, ...(deps.links.siteUrl ? { siteUrl: deps.links.siteUrl } : {}) },
        { locationId: c.locationId, kind: 'book_again', customerId: a.customer_id, issuedBy: 'system' },
      )
      const m = pickedUpMessage({ firstName, receipt, link: link.url })
      const q = await deps.queue.enqueueFor(tx, { ...base, templateKey: m.templateKey, vars: m.vars, ...(m.secretVars ? { secretVars: m.secretVars } : {}) })
      if (!q.queued) throw new LinkTextNotQueued(q)
      return q
    })
    // a link that cannot be issued (an AppError: no number on file) or a link text that cannot go: the plain thank-you is tried
    if (r.ok) {
      out = r.value
      withLink = true
    } else if (!(r.error instanceof LinkTextNotQueued) && !(r.error instanceof AppError)) throw r.error
  }
  if (!out) {
    const m = pickedUpMessage({ firstName, receipt, link: null })
    out = await deps.queue.enqueueFor(tx, { ...base, templateKey: m.templateKey, vars: m.vars })
  }
  if (out.queued && out.duplicate) return
  await logStatusActivity(tx, a.id, now, deliveryNote('Picked-up text', out), {
    status: 'picked_up',
    receiptLine: receipt !== null,
    bookAgainLink: withLink,
  })
}
