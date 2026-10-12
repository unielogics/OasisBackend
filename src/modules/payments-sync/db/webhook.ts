// Squarespace webhook plumbing over Postgres: replay/duplicate protection in the platform webhook_log (unique provider +
// notification id; the notification id, not the order id, so distinct updates of one order are never dropped) and the
// subscription secrets (stored encrypted, plus the optional SQSP_WEBHOOK_SECRET).
import type { NotificationDedupe } from '../../../integrations/squarespace/webhook.js'
import type { Db } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { DbWebhookLog } from '../../../platform/webhook-log.js'
import type { SecretBox } from './secrets.js'

/** The Squarespace face of the platform webhook log (src/platform/webhook-log.ts): provider 'squarespace', keyed on the notification id. */
export class DbNotificationDedupe extends DbWebhookLog implements NotificationDedupe {
  constructor(db: Db, newId: NewId) {
    super(db, newId, 'squarespace')
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
      out.push({
        subscriptionId: r.sqsp_subscription_id,
        locationId: r.location_id,
        secret: box.decrypt(r.secret_enc!),
      })
    } catch {
      // a secret encrypted with a key that is no longer configured cannot verify anything
    }
  }
  return out
}
