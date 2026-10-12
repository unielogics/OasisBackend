// The one automatic follow-up text of a lead (ADR 0160, plan J; job leads.follow_up). A lead who texted and did not book gets ONE
// friendly line (template lead_follow_up, class lead_follow_up) with a personal calendar link when personal links are on, after
// leads.follow_up_delay_min since their last text, and only:
//   - while the assistant is on (AI_ENABLED and assistant.enabled) and leads.follow_up_enabled;
//   - once per lead (status followed_up, follow_up_message_id; the message's idempotency key is lead-follow-up:<lead>);
//   - within leads.within_hours of their last text (the class refuses anything older than 24 hours anyway);
//   - inside business hours when leads.business_hours_only (otherwise it waits for the next opening, still inside the window);
//   - never after a STOP since the lead began (lifted by START or not), never to an opted-out number or client;
//   - never once they booked (any booking since the first contact closes the lead first; that closing runs even while follow-ups
//     are off, since it sends nothing);
//   - never by name or with a client-bound link to a stale record (identity/stale.ts): such a number gets the stranger's text;
//   - only to a number inside the assistant's rollout stage (assistant.stage / assistant.allowlist; the turn's stageAndConsent: in
//     stage customers a stale record is no known customer).
// A follow-up that cannot go any more is dropped (follow_up_at cleared); a new text from the number plans it again.
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import type { Clock } from '../../platform/clock.js'
import type { Db, Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { getSetting } from '../../platform/settings.js'
import { addDays, minutesOfDay, toBizDate, wallToInstant } from '../../platform/time.js'
import type { AssistantLog, AssistantQueue } from '../assistant/contract.js'
import { assistantOn } from '../assistant/tools/switches.js'
import { listCategories } from '../catalog/categories.js'
import { issueClientLink } from '../identity/links.js'
import { staleRecord } from '../identity/stale.js'
import { stageAndConsent } from '../messaging/assistant/gate.js'
import { lastInboundAt, loadCustomerTarget, strangerRecipient } from '../messaging/db/recipients.js'
import { listLiveClosures } from '../settings/closures.js'
import { dayInfo, type DayInfo } from '../settings/day-info.js'
import { emergencySnapshot, getActiveEmergency } from '../settings/emergency.js'
import { getHours } from '../settings/hours.js'
import { followUpDelayMs, reconcileBookedLeads } from './service.js'
import './schema.js'

const HOUR = 3_600_000
const BATCH = 200

export interface LeadJobDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Pick<Env, 'AI_ENABLED' | 'AI_ACTIONS_ENABLED' | 'PUBLIC_LINKS_ENABLED' | 'PUBLIC_SITE_URL' | 'BUSINESS_TZ'>
  queue: AssistantQueue
  log: AssistantLog
}

export interface FollowUpReport {
  locations: number
  /** Locations skipped because the assistant or the follow-up is off. */
  off: number
  reconciledBooked: number
  considered: number
  sent: number
  /** Planned later (their last text moved, or outside business hours). */
  deferred: number
  /** Dropped for good, by reason. */
  dropped: Record<string, number>
}

/** "about window tint": the interest words of the follow-up, from the lead's categories. */
const INTEREST_WORDS: Record<string, string> = {
  wash: 'a wash',
  addons: 'add-ons',
  tint: 'window tint',
  detail: 'detailing',
  quote: 'a quote',
}

export function interestPhrase(keys: readonly string[], labels: ReadonlyMap<string, string>): string | null {
  const words = keys.map((k) => INTEREST_WORDS[k] ?? labels.get(k)?.toLowerCase() ?? null).filter((x): x is string => !!x)
  const uniq = [...new Set(words)].slice(0, 2)
  return uniq.length === 0 ? null : uniq.join(' and ')
}

/** The shop's day as the slot engine sees it (hours, closures, an emergency). */
async function shopDay(db: Executor, locationId: string, tz: string, date: string): Promise<DayInfo> {
  const [hours, closures, emergency] = await Promise.all([
    getHours(db, locationId),
    listLiveClosures(db, locationId, { from: date, to: date }),
    getActiveEmergency(db, locationId),
  ])
  return dayInfo({ date, hours, closures, emergency: emergencySnapshot(emergency, tz) })
}

/** Now when the shop is open now, else its next opening within a week (null when none). */
export async function nextBusinessMoment(db: Executor, locationId: string, tz: string, now: Date): Promise<Date | null> {
  const today = toBizDate(now, tz)
  for (let d = 0; d < 8; d++) {
    const date = addDays(today, d)
    const day = await shopDay(db, locationId, tz, date)
    if (day.closed || day.openMin === null || day.closeMin === null) continue
    if (d === 0) {
      const m = minutesOfDay(now, tz)
      if (m >= day.openMin && m < day.closeMin) return now
      if (m >= day.closeMin) continue
    }
    return wallToInstant(date, day.openMin, tz)
  }
  return null
}

/** Any opt-out of the number or its client at or after `since` (a STOP lifted by START still counts: never after STOP). */
async function stoppedSince(db: Executor, o: { locationId: string; phone: string; customerId: string | null; since: Date }): Promise<boolean> {
  const r = await sql<{ hit: boolean }>`
    select exists (select 1 from sms_opt_outs where location_id = ${o.locationId} and phone_e164 = ${o.phone}
        and (opted_out_at >= ${o.since} or opted_in_again_at is null))
      or exists (select 1 from customers where id = ${o.customerId}::uuid and sms_opted_out_at is not null) as hit`.execute(db)
  return r.rows[0]?.hit === true
}

async function savepoint<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<T> {
  await sql`savepoint ${sql.id(name)}`.execute(tx)
  try {
    const out = await fn()
    await sql`release savepoint ${sql.id(name)}`.execute(tx)
    return out
  } catch (e) {
    await sql`rollback to savepoint ${sql.id(name)}`.execute(tx)
    throw e
  }
}

class NotQueued extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** One pass of the follow-up job over every location (or one). Safe to repeat: a lead is followed up at most once. */
export async function runLeadFollowUps(d: LeadJobDeps, o: { locationId?: string } = {}): Promise<FollowUpReport> {
  const report: FollowUpReport = { locations: 0, off: 0, reconciledBooked: 0, considered: 0, sent: 0, deferred: 0, dropped: {} }
  const drop = (why: string): void => {
    report.dropped[why] = (report.dropped[why] ?? 0) + 1
  }
  let q = d.db.selectFrom('locations').select(['id', 'timezone']).orderBy('created_at').orderBy('id')
  if (o.locationId) q = q.where('id', '=', o.locationId)
  for (const loc of await q.execute()) {
    report.locations += 1
    const tz = loc.timezone ?? d.env.BUSINESS_TZ
    const now = d.clock.now()
    // a booking (by staff, on the website or by text) closes the lead whether or not follow-ups are on: this sends nothing, and the
    // staff lead list must not keep showing people who already booked
    report.reconciledBooked += await reconcileBookedLeads(d.db, loc.id, now)
    if (!(await assistantOn(d.db, d.env, loc.id)) || !(await getSetting(d.db, loc.id, 'leads.follow_up_enabled')).value) {
      report.off += 1
      continue
    }
    const due = await d.db
      .selectFrom('leads')
      .select('id')
      .where('location_id', '=', loc.id)
      .where('status', '=', 'new')
      .where('follow_up_message_id', 'is', null)
      .where('follow_up_at', 'is not', null)
      .where('follow_up_at', '<=', now)
      .orderBy('follow_up_at')
      .limit(BATCH)
      .execute()
    for (const { id } of due) {
      report.considered += 1
      const outcome = await d.db.transaction().execute((tx) => followUpOne(tx, d, { leadId: id, locationId: loc.id, tz, now }))
      if (outcome === 'sent') report.sent += 1
      else if (outcome === 'deferred') report.deferred += 1
      else if (outcome !== 'gone') drop(outcome)
    }
  }
  return report
}

async function followUpOne(
  tx: Tx,
  d: LeadJobDeps,
  o: { leadId: string; locationId: string; tz: string; now: Date },
): Promise<'sent' | 'deferred' | 'gone' | string> {
  const lead = await tx
    .selectFrom('leads')
    .selectAll()
    .where('id', '=', o.leadId)
    .where('status', '=', 'new')
    .where('follow_up_message_id', 'is', null)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst()
  if (!lead || lead.follow_up_at === null) return 'gone'
  const { now } = o
  const setPlan = async (at: Date | null): Promise<void> => {
    await tx
      .updateTable('leads')
      .set((eb) => ({ follow_up_at: at, version: eb('version', '+', 1), updated_at: now }))
      .where('id', '=', lead.id)
      .execute()
  }
  const [delayMs, within, businessOnly] = await Promise.all([
    followUpDelayMs(tx, o.locationId),
    getSetting(tx, o.locationId, 'leads.within_hours'),
    getSetting(tx, o.locationId, 'leads.business_hours_only'),
  ])
  const inbound = await lastInboundAt(tx, o.locationId, lead.phone_e164)
  const lastText = inbound && inbound.getTime() > lead.last_contact_at.getTime() ? inbound : lead.last_contact_at
  const windowEnd = new Date(lastText.getTime() + within.value * HOUR)
  const dueAt = new Date(lastText.getTime() + delayMs)

  if (now.getTime() >= windowEnd.getTime()) {
    await setPlan(null)
    return 'window_passed'
  }
  if (await stoppedSince(tx, { locationId: o.locationId, phone: lead.phone_e164, customerId: lead.customer_id, since: lead.first_contact_at })) {
    await setPlan(null)
    return 'opted_out'
  }
  if (now.getTime() < dueAt.getTime()) {
    await setPlan(dueAt)
    return 'deferred'
  }
  if (businessOnly.value) {
    const next = await nextBusinessMoment(tx, o.locationId, o.tz, now)
    if (next === null || next.getTime() >= windowEnd.getTime()) {
      await setPlan(null)
      return 'no_business_hours_in_window'
    }
    if (next.getTime() > now.getTime()) {
      await setPlan(next)
      return 'deferred'
    }
  }

  // the client of the lead, when the number is still theirs
  const customer = lead.customer_id
    ? await tx
        .selectFrom('customers')
        .select(['id', 'full_name', 'needs_details', 'phone_e164', 'deleted_at', 'merged_into'])
        .where('id', '=', lead.customer_id)
        .executeTakeFirst()
    : undefined
  const live = customer && customer.deleted_at === null && customer.merged_into === null && customer.phone_e164 === lead.phone_e164 ? customer : undefined
  // the rollout stage the assistant answers in (W5: owner and staff numbers first, then clients, then everyone) holds for its
  // follow-up too: a number the assistant would not answer now gets none. The turn's own stage rule (stageAndConsent): in stage
  // customers a record the stale-record rule holds is no known customer (W4c re-review L4); opt-outs are checked below
  if ((await stageAndConsent(tx, { locationId: o.locationId, phone: lead.phone_e164, customerId: live?.id ?? null, optedOut: false, now })) === 'not_in_stage') {
    await setPlan(null)
    return 'not_in_stage'
  }
  // the stale-record rule (identity/stale.ts, design section 5): a record whose number went quiet for 180 days or bounced says
  // nothing about who holds the number today, so the follow-up treats them as a stranger (no name, a link bound to the number only)
  const known = live && !(await staleRecord(tx, { locationId: o.locationId, customerId: live.id, phone: lead.phone_e164, now })).stale ? live : undefined
  const labels = new Map((await listCategories(tx, o.locationId)).map((c) => [c.key, c.label]))
  const interest = interestPhrase(lead.interests, labels)
  const first = known && !known.needs_details ? (known.full_name.trim().split(/\s+/)[0] ?? null) : null

  try {
    const messageId = await savepoint(tx, 'lead_follow_up', async () => {
      let link: string | null = null
      if (d.env.PUBLIC_LINKS_ENABLED) {
        const issued = await issueClientLink(
          tx,
          { newId: d.newId, now, ...(d.env.PUBLIC_SITE_URL ? { siteUrl: d.env.PUBLIC_SITE_URL } : {}) },
          known
            ? { locationId: o.locationId, kind: 'calendar', customerId: known.id, issuedBy: 'system' }
            : { locationId: o.locationId, kind: 'calendar', customerId: null, phone: lead.phone_e164, issuedBy: 'system' },
        )
        link = issued.url
      }
      const target = known ? await loadCustomerTarget(tx, o.locationId, known.id) : null
      const recipient = target?.recipient ?? (await strangerRecipient(tx, o.locationId, lead.phone_e164))
      const out = await d.queue.enqueueFor(tx, {
        locationId: o.locationId,
        customerId: known?.id ?? null,
        recipient,
        appointmentId: null,
        templateKey: 'lead_follow_up',
        vars: { ...(first ? { first } : {}), ...(interest ? { interest } : {}) },
        ...(link ? { secretVars: { link } } : {}),
        purpose: 'lead-follow-up',
        senderKind: 'ai',
        dedupeKey: `lead-follow-up:${lead.id}`,
      })
      if (!out.queued) throw new NotQueued(out.skipped)
      return out.messageId
    })
    await tx
      .updateTable('leads')
      .set((eb) => ({
        status: 'followed_up' as const,
        follow_up_message_id: messageId,
        follow_up_at: null,
        version: eb('version', '+', 1),
        updated_at: now,
      }))
      .where('id', '=', lead.id)
      .execute()
    return 'sent'
  } catch (e) {
    if (!(e instanceof NotQueued)) throw e
    await setPlan(null)
    d.log.info({ lead: lead.id, reason: e.reason }, 'lead follow-up not sent')
    return `not_queued:${e.reason}`
  }
}
