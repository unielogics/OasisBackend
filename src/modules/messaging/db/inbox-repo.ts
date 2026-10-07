import type { Selectable } from 'kysely'
import type { Executor } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { normalizeE164 } from '../../../integrations/sms/phone.js'
import type { InboundDecision, InboundText } from '../inbound/router.js'
import type { InboxRepository, InboxRow } from '../inbound/repositories.js'
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

  async markProcessed(
    id: string,
    decision: InboundDecision['kind'],
    quarantined: boolean,
    at: Date,
  ): Promise<void> {
    await this.exec
      .updateTable('sms_inbox')
      .set({ processed_at: at, decision, quarantined })
      .where('id', '=', id)
      .execute()
  }

  /** Links the inbox row to the customer, appointment and message the text was filed under. */
  async attach(
    deviceId: string,
    providerMessageId: string,
    link: { customerId: string | null; appointmentId: string | null; messageId: string | null },
  ): Promise<void> {
    await this.exec
      .updateTable('sms_inbox')
      .set({ customer_id: link.customerId, appointment_id: link.appointmentId, message_id: link.messageId })
      .where('device_id', '=', deviceId)
      .where('provider_message_id', '=', providerMessageId)
      .execute()
  }
}
