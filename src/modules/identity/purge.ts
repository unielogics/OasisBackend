// Retention of the identity tables (maintenance.retention, daily): sessions a day past their end, links a week past their expiry or
// revocation (their sessions go with them; the code rows stay with the session cleared, so the hourly ceiling still counts them),
// wrong-PIN rows two days old (the longest rolling window is a day), trust rows that ended 180 days ago (a verification is activity
// for the stale-record rule until then), and in-chat actions resolved 90 days ago; pending actions past their 15 minutes become
// expired first. customer_pins is never purged: the row keeps the version counting, so a link issued before a clear stays dead.
import type { Db } from '../../platform/db.js'
import { expirePendingActions } from './pending-actions.js'
import './schema.js'

const DAY = 86_400_000

export const IDENTITY_RETENTION = {
  sessionsMs: DAY,
  linksMs: 7 * DAY,
  pinFailuresMs: 2 * DAY,
  trustMs: 180 * DAY,
  pendingActionsMs: 90 * DAY,
} as const

export async function purgeIdentityRows(db: Db, now: Date): Promise<number> {
  const before = (ms: number) => new Date(now.getTime() - ms)
  let n = await expirePendingActions(db, now)
  const sessions = await db
    .deleteFrom('client_link_sessions')
    .where((eb) => eb.or([eb('expires_at', '<', before(IDENTITY_RETENTION.sessionsMs)), eb('revoked_at', '<', before(IDENTITY_RETENTION.sessionsMs))]))
    .executeTakeFirst()
  const links = await db
    .deleteFrom('client_links')
    .where((eb) => eb.or([eb('expires_at', '<', before(IDENTITY_RETENTION.linksMs)), eb('revoked_at', '<', before(IDENTITY_RETENTION.linksMs))]))
    .executeTakeFirst()
  const fails = await db.deleteFrom('identity_pin_failures').where('at', '<', before(IDENTITY_RETENTION.pinFailuresMs)).executeTakeFirst()
  const trust = await db
    .deleteFrom('phone_trust')
    .where((eb) => eb.or([eb('expires_at', '<', before(IDENTITY_RETENTION.trustMs)), eb('revoked_at', '<', before(IDENTITY_RETENTION.trustMs))]))
    .executeTakeFirst()
  const actions = await db
    .deleteFrom('assistant_pending_actions')
    .where('state', '<>', 'pending')
    .where('resolved_at', '<', before(IDENTITY_RETENTION.pendingActionsMs))
    .executeTakeFirst()
  for (const r of [sessions, links, fails, trust, actions]) n += Number(r.numDeletedRows)
  return n
}
