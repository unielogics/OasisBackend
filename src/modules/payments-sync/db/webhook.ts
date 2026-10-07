// Squarespace webhook plumbing over Postgres: replay/duplicate protection in the platform webhook_log (unique provider +
// notification id; the notification id, not the order id, so distinct updates of one order are never dropped) and the
// subscription secrets (stored encrypted, plus the optional SQSP_WEBHOOK_SECRET).
import type { NotificationDedupe } from '../../../integrations/squarespace/webhook.js'
import type { Db } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import type { SecretBox } from './secrets.js'

export class DbNotificationDedupe implements NotificationDedupe {
  constructor(
    private readonly db: Db,
    private readonly newId: NewId,
  ) {}

  async claim(notificationId: string, now: Date): Promise<boolean> {
    const r = await this.db
      .insertInto('webhook_log')
      .values({
        id: this.newId(),
        provider: 'squarespace',
        external_id: notificationId,
        headers: '{}',
        body: null,
        signature_valid: true,
        received_at: now,
        status: 'received',
      })
      .onConflict((oc) => oc.columns(['provider', 'external_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    return r !== undefined
  }

  async release(notificationId: string): Promise<void> {
    await this.db
      .deleteFrom('webhook_log')
      .where('provider', '=', 'squarespace')
      .where('external_id', '=', notificationId)
      .execute()
  }

  /** Keep what arrived (headers without the signature, raw body) for the 90-day trail. */
  async record(notificationId: string, headers: Record<string, string>, body: string): Promise<void> {
    await this.db
      .updateTable('webhook_log')
      .set({ headers: JSON.stringify(headers), body })
      .where('provider', '=', 'squarespace')
      .where('external_id', '=', notificationId)
      .execute()
  }

  async finish(
    notificationId: string,
    status: 'processed' | 'ignored' | 'failed',
    now: Date,
    error?: string,
  ): Promise<void> {
    await this.db
      .updateTable('webhook_log')
      .set({ status, processed_at: now, error: error ?? null })
      .where('provider', '=', 'squarespace')
      .where('external_id', '=', notificationId)
      .execute()
  }
}

export interface StoredSecret {
  subscriptionId: string
  locationId: string
  secret: string
}

export async function loadWebhookSecrets(db: Db, box: SecretBox | undefined): Promise<StoredSecret[]> {
  if (!box) return []
  const rows = await db
    .selectFrom('sqsp_webhook_subscriptions')
    .select(['sqsp_subscription_id', 'location_id', 'secret_enc'])
    .where('secret_enc', 'is not', null)
    .execute()
  const out: StoredSecret[] = []
  for (const r of rows) {
    try {
      out.push({ subscriptionId: r.sqsp_subscription_id, locationId: r.location_id, secret: box.decrypt(r.secret_enc!) })
    } catch {
      // a secret encrypted with a key that is no longer configured cannot verify anything
    }
  }
  return out
}
