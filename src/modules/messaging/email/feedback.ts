// SES feedback over Postgres (ADR 0110): the suppression list that every send checks, customers.email_bounced_at, the per-message
// feedback on outbox_emails, an activity-log line on the job a bounced receipt belonged to, and a notification to the people who
// run the shop when an address is newly suppressed. One transaction per notification, so a failure leaves nothing half written
// and SNS retries the whole delivery.
import { sql } from 'kysely'
import type { FeedbackDecision } from '../../../integrations/email/ses-events.js'
import type { IsSuppressed } from '../../../integrations/email/suppression.js'
import type { Clock } from '../../../platform/clock.js'
import type { Db, Executor, Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { getDefaultLocation } from '../../../platform/locations.js'
import { maskEmail } from '../../../platform/phone.js'
import * as realtime from '../../../platform/realtime.js'
import { loadAuthority } from '../../rbac/service.js'
import { managersOf, notifyManagers } from '../notify.js'
import '../schema.js'
import '../../customers/schema.js'

const MAX_SOURCE_IDS = 20

export interface Suppression {
  address: string
  reason: 'bounce' | 'complaint'
  bounceType: string | null
  bounceSubType: string | null
  complaintFeedbackType: string | null
  firstSeenAt: Date
  lastSeenAt: Date
  count: number
}

/** The active suppression of an address (already normalized), or null. */
export async function activeSuppression(db: Executor, address: string): Promise<Suppression | null> {
  const r = await db
    .selectFrom('email_suppressions')
    .selectAll()
    .where('address', '=', address.trim().toLowerCase())
    .where('cleared_at', 'is', null)
    .executeTakeFirst()
  if (!r) return null
  return {
    address: r.address,
    reason: r.reason,
    bounceType: r.bounce_type,
    bounceSubType: r.bounce_subtype,
    complaintFeedbackType: r.complaint_feedback_type,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    count: r.count,
  }
}

/** Why an address is suppressed, in the words the outbox row records. */
export function suppressionReason(s: Suppression): string {
  const what =
    s.reason === 'complaint'
      ? 'the recipient marked an earlier email as spam'
      : `it bounced${s.bounceType ? ` (${[s.bounceType, s.bounceSubType].filter(Boolean).join(' / ')})` : ''}`
  return `Not sent: ${maskEmail(s.address)} is suppressed because ${what} on ${s.lastSeenAt.toISOString().slice(0, 10)}`
}

/** The suppression check the messaging runtime wires into its EmailProvider. */
export function dbSuppressionCheck(db: Db): IsSuppressed {
  return async (address) => {
    const s = await activeSuppression(db, address)
    return s ? suppressionReason(s) : false
  }
}

export interface FeedbackDeps {
  clock: Clock
  newId: NewId
}

export interface FeedbackOutcome {
  /** Addresses that were not suppressed before this notification. */
  newlySuppressed: string[]
  suppressed: number
  softBounces: number
  delivered: number
  /** Decisions that found their outbox_emails row. */
  matched: number
}

interface OutboxMatch {
  id: string
  location_id: string
  appointment_id: string | null
  template: string
  feedback: string | null
}

const TEMPLATE_LABEL: Record<string, string> = {
  receipt: 'Receipt email',
  staff_invite: 'Invitation email',
  password_reset: 'Password reset email',
  closure_notice: 'Closure email',
  device_alert: 'Alert email',
}

function detailOf(d: FeedbackDecision): string {
  const kind =
    d.reason === 'complaint'
      ? `complaint${d.complaintFeedbackType ? ` (${d.complaintFeedbackType})` : ''}`
      : [d.bounceType, d.bounceSubType].filter(Boolean).join(' / ')
  return `${kind}${d.diagnostic ? `: ${d.diagnostic}` : ''}`.slice(0, 500)
}

async function matchOutbox(tx: Tx, d: FeedbackDecision): Promise<OutboxMatch | undefined> {
  return tx
    .selectFrom('outbox_emails')
    .select(['id', 'location_id', 'appointment_id', 'template', 'feedback'])
    .where('provider_message_id', '=', d.messageId)
    .where(sql<boolean>`lower(btrim(to_email)) = ${d.address}`)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
}

async function suppress(tx: Tx, d: FeedbackDecision, at: Date): Promise<boolean> {
  const before = await tx
    .selectFrom('email_suppressions')
    .select(['cleared_at'])
    .where('address', '=', d.address)
    .forUpdate()
    .executeTakeFirst()
  const reason = d.reason === 'complaint' ? 'complaint' : 'bounce'
  await sql`
    insert into email_suppressions (address, reason, bounce_type, bounce_subtype, complaint_feedback_type, diagnostic,
                                    first_seen_at, last_seen_at, count, source_message_ids, created_at, updated_at)
    values (${d.address}, ${reason}, ${d.bounceType ?? null}, ${d.bounceSubType ?? null}, ${d.complaintFeedbackType ?? null},
            ${d.diagnostic ?? null}, ${at}, ${at}, 1, array[${d.messageId}]::text[], ${at}, ${at})
    on conflict (address) do update set
      reason = case when email_suppressions.reason = 'complaint' or excluded.reason = 'complaint' then 'complaint' else 'bounce' end,
      bounce_type = coalesce(excluded.bounce_type, email_suppressions.bounce_type),
      bounce_subtype = coalesce(excluded.bounce_subtype, email_suppressions.bounce_subtype),
      complaint_feedback_type = coalesce(excluded.complaint_feedback_type, email_suppressions.complaint_feedback_type),
      diagnostic = coalesce(excluded.diagnostic, email_suppressions.diagnostic),
      last_seen_at = greatest(email_suppressions.last_seen_at, excluded.last_seen_at),
      count = email_suppressions.count + case when ${d.messageId} = any(email_suppressions.source_message_ids) then 0 else 1 end,
      source_message_ids = case when ${d.messageId} = any(email_suppressions.source_message_ids)
        then email_suppressions.source_message_ids
        else (array_append(email_suppressions.source_message_ids, ${d.messageId}))[
          greatest(1, cardinality(email_suppressions.source_message_ids) + 2 - ${MAX_SOURCE_IDS}):] end,
      cleared_at = null,
      cleared_by = null,
      updated_at = excluded.updated_at`.execute(tx)
  return !before || before.cleared_at !== null
}

/** Applies the decisions of one SES notification. */
export async function recordFeedback(db: Db, decisions: FeedbackDecision[], deps: FeedbackDeps): Promise<FeedbackOutcome> {
  const out: FeedbackOutcome = { newlySuppressed: [], suppressed: 0, softBounces: 0, delivered: 0, matched: 0 }
  if (decisions.length === 0) return out
  await db.transaction().execute(async (tx) => {
    for (const d of decisions) {
      const at = d.at ?? deps.clock.now()
      const row = await matchOutbox(tx, d)
      if (row) out.matched += 1
      if (d.action === 'delivered') {
        out.delivered += 1
        if (row) await tx.updateTable('outbox_emails').set({ delivered_at: sql`coalesce(delivered_at, ${at})` }).where('id', '=', row.id).execute()
        continue
      }
      if (d.action === 'soft_bounce') {
        out.softBounces += 1
        // a soft bounce never overwrites the record of a hard bounce or a complaint on the same message
        if (row && (row.feedback === null || row.feedback === 'soft_bounce'))
          await tx.updateTable('outbox_emails').set({ feedback: 'soft_bounce', feedback_at: at, feedback_detail: detailOf(d) }).where('id', '=', row.id).execute()
        continue
      }
      out.suppressed += 1
      const isNew = await suppress(tx, d, at)
      await tx
        .updateTable('customers')
        .set({ email_bounced_at: at })
        .where(sql<boolean>`lower(btrim(email::text)) = ${d.address}`)
        .where('email_bounced_at', 'is', null)
        .execute()
      const feedback = d.reason === 'complaint' ? 'complaint' : 'hard_bounce'
      if (row) {
        await tx.updateTable('outbox_emails').set({ feedback, feedback_at: at, feedback_detail: detailOf(d) }).where('id', '=', row.id).execute()
        if (row.appointment_id)
          await tx
            .insertInto('activity_log')
            .values({
              appointment_id: row.appointment_id,
              at,
              text:
                d.reason === 'complaint'
                  ? `${TEMPLATE_LABEL[row.template] ?? 'Email'} reported as spam by the recipient; no more email to ${maskEmail(d.address)}`
                  : `${TEMPLATE_LABEL[row.template] ?? 'Email'} to ${maskEmail(d.address)} bounced; no more email to that address`,
              channels: ['email', 'system'],
              actor_type: 'system',
              meta: JSON.stringify({ outboxEmailId: row.id, feedback, sesMessageId: d.messageId }) as never,
            })
            .execute()
      }
      if (isNew) {
        out.newlySuppressed.push(d.address)
        await noticeNewSuppression(tx, d, row, deps)
      }
    }
  })
  return out
}

async function noticeNewSuppression(tx: Tx, d: FeedbackDecision, row: OutboxMatch | undefined, deps: FeedbackDeps): Promise<void> {
  const locationId = row?.location_id ?? (await getDefaultLocation(tx))?.id
  if (!locationId) return
  const employee = await tx
    .selectFrom('employees')
    .select(['id', 'first', 'last'])
    .where(sql<boolean>`lower(btrim(email::text)) = ${d.address}`)
    .executeTakeFirst()
  const customer = employee
    ? undefined
    : await tx
        .selectFrom('customers')
        .select(['id', 'full_name'])
        .where(sql<boolean>`lower(btrim(email::text)) = ${d.address}`)
        .where('deleted_at', 'is', null)
        .orderBy('created_at')
        .executeTakeFirst()
  const who = employee ? `${employee.first} ${employee.last}`.trim() : (customer?.full_name ?? maskEmail(d.address))
  const why = d.reason === 'complaint' ? 'marked an email from us as spam' : 'bounced'
  await notifyManagers(
    tx,
    {
      locationId,
      kind: 'email.suppressed',
      title: 'Email address suppressed',
      body: `${maskEmail(d.address)} (${who}) ${why}. Oasis will not email it again until the address is corrected${
        employee ? '; invitation and password reset links for this person must go by SMS or be handed over' : ''
      }.`,
      entityType: employee ? 'employee' : customer ? 'customer' : null,
      entityId: employee?.id ?? customer?.id ?? null,
    },
    deps,
  )
}

/**
 * An invitation or password-reset link could not be emailed because the address is suppressed: every Super Admin gets a
 * notification (the API response of a Super Admin also carries the link, since nothing was delivered).
 */
export async function noticeSuppressedAccountLink(
  db: Db,
  a: { locationId: string; employeeId: string; firstName: string; kind: 'invite' | 'password_reset'; address: string },
  deps: FeedbackDeps,
): Promise<number> {
  const what = a.kind === 'invite' ? 'invitation' : 'password reset link'
  return db.transaction().execute(async (tx) => {
    const supers = []
    for (const m of await managersOf(tx, a.locationId)) if ((await loadAuthority(tx, m.employeeId)).isSuper) supers.push(m)
    for (const m of supers) {
      const id = deps.newId()
      await tx
        .insertInto('notifications')
        .values({
          id,
          location_id: a.locationId,
          employee_id: m.employeeId,
          role_target: null,
          kind: 'email.suppressed_account_link',
          title: `${a.firstName}'s ${what} was not emailed`,
          body: `${maskEmail(a.address)} is suppressed after a bounce or complaint, so the ${what} was not sent. Correct the email address or send it by SMS, then send it again.`,
          entity_type: 'employee',
          entity_id: a.employeeId,
          created_at: deps.clock.now(),
          read_at: null,
        })
        .execute()
      await realtime.publish(tx, {
        locationId: a.locationId,
        channel: 'notifications',
        type: 'notification.new',
        payload: { id, kind: 'email.suppressed_account_link' },
        targetUserId: m.userId,
      })
    }
    return supers.length
  })
}
