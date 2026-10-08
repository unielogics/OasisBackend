// Email through the EmailProvider port (SES, or the console driver in development). Messages are queued in outbox_emails
// inside the caller's transaction and sent by a job (or right away for the few that a person is waiting on).
import { sql } from 'kysely'
import type { Clock } from '../../../platform/clock.js'
import type { Db, Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import type { EmailProvider } from '../../../integrations/ports/email.js'
import { EmailError } from '../../../integrations/email/errors.js'
import type { SentEmail } from '../../../integrations/email/console-provider.js'
import '../schema.js'

/** Templates whose variables carry a one-time link; the variables are wiped once the row is final. */
export const SENSITIVE_EMAIL_TEMPLATES: ReadonlySet<string> = new Set(['staff_invite', 'password_reset'])

export type EmailVars = Record<string, string | number>

export interface QueueEmailArgs {
  locationId: string
  to: string
  template: string
  vars: EmailVars
  purpose: string
  customerId?: string | null
  employeeId?: string | null
  /** The job the email is about (a receipt): a bounce is written to that job's activity log. */
  appointmentId?: string | null
  /** A second queue call with the same key does nothing and returns duplicate. */
  dedupeKey?: string
}

const MAX_ATTEMPTS = 5
const backoffMs = (attempts: number): number => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1))

export async function queueEmail(tx: Tx, a: QueueEmailArgs, o: { newId: NewId; clock: Clock }): Promise<{ emailId: string; duplicate: boolean }> {
  const id = o.newId()
  const r = await tx
    .insertInto('outbox_emails')
    .values({
      id,
      location_id: a.locationId,
      customer_id: a.customerId ?? null,
      employee_id: a.employeeId ?? null,
      ...(a.appointmentId ? { appointment_id: a.appointmentId } : {}),
      to_email: a.to,
      template: a.template,
      vars: JSON.stringify(a.vars) as never,
      purpose: a.purpose,
      dedupe_key: a.dedupeKey ?? null,
      created_at: o.clock.now(),
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst()
  if (r) return { emailId: r.id, duplicate: false }
  const prior = await tx.selectFrom('outbox_emails').select('id').where('dedupe_key', '=', a.dedupeKey ?? '').executeTakeFirstOrThrow()
  return { emailId: prior.id, duplicate: true }
}

export interface EmailSendReport {
  sent: number
  failed: number
  retried: number
  suppressed: number
}

export class EmailSender {
  private captured: SentEmail | undefined

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly provider: () => EmailProvider,
  ) {}

  /** Wire this as `onSimSend` of the console driver so the mailbox row shows exactly what would have been sent. */
  capture = (mail: SentEmail): void => {
    this.captured = mail
  }

  /** Sends what is due, oldest first. Rows stuck in `sending` (a crash) go back to pending first. */
  async sendDue(limit = 20): Promise<EmailSendReport> {
    const now = this.clock.now()
    await sql`update outbox_emails set state = 'pending', locked_at = null
      where state = 'sending' and locked_at < ${new Date(now.getTime() - 5 * 60_000)}`.execute(this.db)
    const claimed = await sql<{ id: string }>`
      update outbox_emails set state = 'sending', locked_at = ${now}
      where id in (
        select id from outbox_emails
        where state = 'pending' and (next_attempt_at is null or next_attempt_at <= ${now})
        order by created_at limit ${limit} for update skip locked)
      returning id`.execute(this.db)
    const report: EmailSendReport = { sent: 0, failed: 0, retried: 0, suppressed: 0 }
    for (const { id } of claimed.rows) {
      const outcome = await this.sendClaimed(id)
      report[outcome] += 1
    }
    return report
  }

  /** Sends one specific queued email now (a person is waiting on an invite or a reset link). */
  async sendNow(id: string): Promise<'sent' | 'failed' | 'retried' | 'suppressed' | 'skipped'> {
    const now = this.clock.now()
    const r = await sql<{ id: string }>`
      update outbox_emails set state = 'sending', locked_at = ${now}
      where id = (select id from outbox_emails where id = ${id} and state = 'pending' for update skip locked)
      returning id`.execute(this.db)
    if (r.rows.length === 0) return 'skipped'
    return this.sendClaimed(id)
  }

  private async sendClaimed(id: string): Promise<'sent' | 'failed' | 'retried' | 'suppressed'> {
    const row = await this.db.selectFrom('outbox_emails').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    const now = this.clock.now()
    const scrub = SENSITIVE_EMAIL_TEMPLATES.has(row.template)
    this.captured = undefined
    try {
      const res = await this.provider().send({ to: row.to_email, template: row.template, vars: row.vars as Record<string, string | number> })
      const mail = this.captured as SentEmail | undefined
      await this.db
        .updateTable('outbox_emails')
        .set({
          state: 'sent',
          sent_at: now,
          locked_at: null,
          attempts: row.attempts + 1,
          provider_message_id: res.id,
          error: null,
          ...(mail && !scrub ? { subject: mail.subject, body: mail.text } : {}),
          ...(scrub ? { vars: '{}' as never } : {}),
        })
        .where('id', '=', id)
        .execute()
      return 'sent'
    } catch (err) {
      const attempts = row.attempts + 1
      const message = (err as Error).message.slice(0, 500)
      if (err instanceof EmailError && err.code === 'SUPPRESSED') {
        await this.finish(id, 'suppressed', attempts, message, scrub)
        return 'suppressed'
      }
      const retryable = !(err instanceof EmailError) || err.retryable
      if (retryable && attempts < MAX_ATTEMPTS) {
        await this.db
          .updateTable('outbox_emails')
          .set({ state: 'pending', locked_at: null, attempts, error: message, error_at: now, next_attempt_at: new Date(now.getTime() + backoffMs(attempts)) })
          .where('id', '=', id)
          .execute()
        return 'retried'
      }
      await this.finish(id, 'failed', attempts, message, scrub)
      return 'failed'
    }
  }

  private async finish(id: string, state: 'failed' | 'suppressed', attempts: number, error: string, scrub: boolean): Promise<void> {
    await this.db
      .updateTable('outbox_emails')
      .set({ state, attempts, error, error_at: this.clock.now(), locked_at: null, ...(scrub ? { vars: '{}' as never } : {}) })
      .where('id', '=', id)
      .execute()
  }
}

