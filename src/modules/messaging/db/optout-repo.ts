import type { Executor } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import type { OptOutRecord, OptOutRepository } from '../policy/optouts.js'
import { inTx } from './exec.js'
import '../schema.js'
import '../../customers/schema.js'

/**
 * Opt-outs by phone number (sms_opt_outs), kept in step with the customer rows that carry the number: a STOP sets
 * customers.sms_opted_out_at, a START clears it and records the keyword as the opt-in source.
 */
export class PgOptOutRepository implements OptOutRepository {
  constructor(
    private readonly exec: Executor,
    private readonly o: { locationId: string; newId: NewId },
  ) {}

  async findActive(phone: string): Promise<OptOutRecord | null> {
    const r = await this.exec
      .selectFrom('sms_opt_outs')
      .selectAll()
      .where('location_id', '=', this.o.locationId)
      .where('phone_e164', '=', phone)
      .where('opted_in_again_at', 'is', null)
      .executeTakeFirst()
    if (!r) return null
    return {
      phone: r.phone_e164,
      optedOutAt: r.opted_out_at,
      source: r.source,
      ...(r.keyword ? { keyword: r.keyword } : {}),
      ...(r.inbound_message_id ? { inboundMessageId: r.inbound_message_id } : {}),
      optedInAgainAt: null,
    }
  }

  async optOut(record: Omit<OptOutRecord, 'optedInAgainAt'> & { optedOutBy?: string | null }): Promise<{ created: boolean }> {
    return inTx(this.exec, async (tx) => {
      const r = await tx
        .insertInto('sms_opt_outs')
        .values({
          id: this.o.newId(),
          location_id: this.o.locationId,
          phone_e164: record.phone,
          opted_out_at: record.optedOutAt,
          source: record.source,
          keyword: record.keyword ?? null,
          inbound_message_id: record.inboundMessageId ?? null,
          opted_out_by: record.optedOutBy ?? null,
        })
        .onConflict((oc) => oc.columns(['location_id', 'phone_e164']).where('opted_in_again_at', 'is', null).doNothing())
        .executeTakeFirst()
      await tx
        .updateTable('customers')
        .set((eb) => ({ sms_opted_out_at: record.optedOutAt, version: eb('version', '+', 1), updated_at: record.optedOutAt }))
        .where('phone_e164', '=', record.phone)
        .where('merged_into', 'is', null)
        .where('deleted_at', 'is', null)
        .where('sms_opted_out_at', 'is', null)
        .execute()
      return { created: Number(r.numInsertedOrUpdatedRows ?? 0n) > 0 }
    })
  }

  async optIn(phone: string, at: Date): Promise<{ wasOptedOut: boolean }> {
    return inTx(this.exec, async (tx) => {
      const cleared = await tx
        .updateTable('sms_opt_outs')
        .set({ opted_in_again_at: at })
        .where('location_id', '=', this.o.locationId)
        .where('phone_e164', '=', phone)
        .where('opted_in_again_at', 'is', null)
        .returning('id')
        .execute()
      await tx
        .updateTable('customers')
        .set((eb) => ({
          sms_opted_out_at: null,
          sms_opted_in: true,
          sms_opt_in_source: 'keyword',
          sms_opt_in_at: at,
          version: eb('version', '+', 1),
          updated_at: at,
        }))
        .where('phone_e164', '=', phone)
        .where('merged_into', 'is', null)
        .where('deleted_at', 'is', null)
        .execute()
      return { wasOptedOut: cleared.length > 0 }
    })
  }
}
