// The provider-parameterised webhook log (webhook_log, unique provider + external id): the duplicate and replay guard of the signed
// hooks and of the Square Events API catch-up. claim() inserts the row the first time an id is seen and says whether this caller won;
// release() gives the id back when the work could not even be queued (the provider's retry is then accepted); record() keeps what
// arrived (headers without the signature, the raw body) for the 90-day trail; finish() closes the row.
import type { Executor } from './db.js'
import type { NewId } from './ids.js'
import type { WebhookLogTable } from './schema.js'

export type WebhookProvider = WebhookLogTable['provider']
export type WebhookLogStatus = 'processed' | 'ignored' | 'failed'

export class DbWebhookLog {
  constructor(
    protected readonly db: Executor,
    protected readonly newId: NewId,
    readonly provider: WebhookProvider,
  ) {}

  /** True the first time the id is claimed, false for a duplicate or a replay. */
  async claim(
    externalId: string,
    now: Date,
    o: { headers?: Record<string, string>; body?: string | null } = {},
  ): Promise<boolean> {
    const r = await this.db
      .insertInto('webhook_log')
      .values({
        id: this.newId(),
        provider: this.provider,
        external_id: externalId,
        headers: JSON.stringify(o.headers ?? {}),
        body: o.body ?? null,
        signature_valid: true,
        received_at: now,
        status: 'received',
      })
      .onConflict((oc) => oc.columns(['provider', 'external_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    return r !== undefined
  }

  async release(externalId: string): Promise<void> {
    await this.db.deleteFrom('webhook_log').where('provider', '=', this.provider).where('external_id', '=', externalId).execute()
  }

  async record(externalId: string, headers: Record<string, string>, body: string): Promise<void> {
    await this.db
      .updateTable('webhook_log')
      .set({ headers: JSON.stringify(headers), body })
      .where('provider', '=', this.provider)
      .where('external_id', '=', externalId)
      .execute()
  }

  /** Closes the row; a failure also counts one more attempt (processed_at is then the last try). */
  async finish(externalId: string, status: WebhookLogStatus, now: Date, error?: string): Promise<void> {
    await this.db
      .updateTable('webhook_log')
      .set((eb) => ({
        status,
        processed_at: now,
        error: error ? error.slice(0, 500) : null,
        ...(status === 'failed' ? { attempts: eb('attempts', '+', 1) } : {}),
      }))
      .where('provider', '=', this.provider)
      .where('external_id', '=', externalId)
      .execute()
  }

  async get(externalId: string) {
    return this.db
      .selectFrom('webhook_log')
      .selectAll()
      .where('provider', '=', this.provider)
      .where('external_id', '=', externalId)
      .executeTakeFirst()
  }
}
