import type { Executor } from '../../../platform/db.js'
import type { ProcessedEventRepository } from '../dispatch/types.js'
import '../schema.js'

/**
 * Envelope ids the ingestor has applied. Bound to the transaction that applies the event, a failed handler rolls the row
 * back with everything else, so forget() has nothing to do there and must not touch an aborted transaction.
 */
export class PgProcessedEvents implements ProcessedEventRepository {
  constructor(private readonly exec: Executor) {}

  async markIfNew(eventId: string, at: Date): Promise<boolean> {
    const r = await this.exec
      .insertInto('sms_processed_events')
      .values({ event_id: eventId, processed_at: at })
      .onConflict((oc) => oc.column('event_id').doNothing())
      .executeTakeFirst()
    return Number(r.numInsertedOrUpdatedRows ?? 0n) > 0
  }

  async forget(eventId: string): Promise<void> {
    if (this.exec.isTransaction) return
    await this.exec.deleteFrom('sms_processed_events').where('event_id', '=', eventId).execute().catch(() => undefined)
  }
}
