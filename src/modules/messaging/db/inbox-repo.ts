import { sql, type Selectable } from 'kysely'
import type { Executor } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { normalizeE164 } from '../../../integrations/sms/phone.js'
import type { InboundDecision, InboundText } from '../inbound/router.js'
import type { InboxRepository, InboxRow } from '../inbound/repositories.js'
import type { MmsAttachmentRecord } from '../inbound/mms.js'
import type { SmsInboxTable } from '../schema.js'
import '../schema.js'

const rowOf = (r: Selectable<SmsInboxTable>): InboxRow => ({
  id: r.id,
  deviceId: r.device_id,
  providerMessageId: r.provider_message_id,
  fromRaw: r.from_raw,
  fromE164: r.from_e164,
  body: r.body,
  deviceReceivedAt: r.device_received_at,
  receivedAt: r.received_at,
  processedAt: r.processed_at,
  decision: r.decision as InboundDecision['kind'] | null,
  quarantined: r.quarantined,
  messageId: r.message_id,
  supersededBy: r.superseded_by,
})

/** sms_inbox: every received text, unique per (device, provider message id). Unknown senders are quarantined, never made customers. */
export class PgInboxRepository implements InboxRepository {
  constructor(
    private readonly exec: Executor,
    private readonly newId: NewId,
  ) {}

  async insertIfNew(msg: InboundText, receivedAt: Date): Promise<{ inserted: boolean; row: InboxRow }> {
    const r = await this.exec
      .insertInto('sms_inbox')
      .values({
        id: this.newId(),
        device_id: msg.deviceId,
        provider_message_id: msg.providerMessageId,
        from_raw: msg.from,
        from_e164: normalizeE164(msg.from),
        body: msg.body,
        kind: msg.kind ?? 'sms',
        device_received_at: msg.receivedAt,
        received_at: receivedAt,
      })
      .onConflict((oc) => oc.columns(['device_id', 'provider_message_id']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (r) return { inserted: true, row: rowOf(r) }
    const existing = await this.exec
      .selectFrom('sms_inbox')
      .selectAll()
      .where('device_id', '=', msg.deviceId)
      .where('provider_message_id', '=', msg.providerMessageId)
      .executeTakeFirstOrThrow()
    return { inserted: false, row: rowOf(existing) }
  }

  async markProcessed(id: string, decision: InboundDecision['kind'], quarantined: boolean, at: Date): Promise<void> {
    await this.exec.updateTable('sms_inbox').set({ processed_at: at, decision, quarantined }).where('id', '=', id).execute()
  }

  async find(deviceId: string, providerMessageId: string): Promise<InboxRow | null> {
    const r = await this.exec.selectFrom('sms_inbox').selectAll().where('device_id', '=', deviceId).where('provider_message_id', '=', providerMessageId).executeTakeFirst()
    return r ? rowOf(r) : null
  }

  async markSuperseded(id: string, byId: string, at: Date): Promise<boolean> {
    const r = await this.exec
      .updateTable('sms_inbox')
      .set({ superseded_by: byId, superseded_at: at })
      .where('id', '=', id)
      .where('superseded_by', 'is', null)
      .executeTakeFirst()
    return Number(r.numUpdatedRows) > 0
  }

  /** A transaction-scoped advisory lock: the incomplete and the complete delivery of one MMS never interleave. */
  async lock(deviceId: string, key: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`sms_inbox:${deviceId}:${key}`}, 0))`.execute(this.exec)
  }

  /** Records the parts of an MMS (what was saved, what was only listed). */
  async setAttachments(id: string, attachments: MmsAttachmentRecord[]): Promise<void> {
    await this.exec.updateTable('sms_inbox').set({ attachments: JSON.stringify(attachments) }).where('id', '=', id).execute()
  }

  /** Links the inbox row to the customer, appointment and message the text was filed under. */
  async attach(deviceId: string, providerMessageId: string, link: { customerId: string | null; appointmentId: string | null; messageId: string | null }): Promise<void> {
    await this.exec
      .updateTable('sms_inbox')
      .set({ customer_id: link.customerId, appointment_id: link.appointmentId, message_id: link.messageId })
      .where('device_id', '=', deviceId)
      .where('provider_message_id', '=', providerMessageId)
      .execute()
  }
}
