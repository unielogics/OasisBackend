// The Needs attention alert of kiosk mode (ADR 0180 A15): "The shop's internet address may have changed". Computed on read like the
// other alerts (src/modules/messaging/adapters/alerts.ts), so it is raised once per refused address, never repeated while that entry
// stands, and resolved by itself when the address is approved (the entry is deleted) or the entry is pruned (30 days, 50 rows).
//
// Shown to the shop's Super Admins (the ones who can add the address) when a refused entry
//   - came from a known shop browser (one that unlocked at the shop and was not removed since), and
//   - no shop network was in use after that entry was first refused (shopActiveSince is false: a phone away from the shop while the
//     tablet keeps working there is not a provider change), and
//   - is at least 10 minutes old (a network's last_seen_at is written at most every 5 minutes, so a shop still in use has shown it by
//     then), while kiosk mode is on.
// At most one alert at a time (the newest such entry): a flood cannot create many, and unknown browsers never raise one.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { getSetting } from '../../platform/settings.js'
import type { ExternalAlert, ExternalAlertSource } from '../scheduling/ports.js'
import { KIOSK_NETWORK_SEEN_MS } from './network.js'
import './schema.js'

/** A refused entry waits this long before it can raise the alert (twice the last-seen write throttle). */
export const KIOSK_ADDRESS_ALERT_AFTER_MS = 2 * KIOSK_NETWORK_SEEN_MS
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

export const kioskAlertSource: ExternalAlertSource = {
  async list(db: Executor, ctx: { locationId: string; now: Date; manager: boolean; superAdmin?: boolean }): Promise<ExternalAlert[]> {
    if (!ctx.superAdmin) return []
    if (!(await getSetting(db, ctx.locationId, 'kiosk.enabled')).value) return []
    const row = await db
      .selectFrom('kiosk_refused_networks as r')
      .innerJoin('kiosk_devices as d', 'd.id', 'r.known_device_id')
      .select(['r.id', 'd.name'])
      .where('r.location_id', '=', ctx.locationId)
      .where('d.revoked_at', 'is', null)
      .where('r.first_seen_at', '<=', new Date(ctx.now.getTime() - KIOSK_ADDRESS_ALERT_AFTER_MS))
      .where('r.last_seen_at', '>=', new Date(ctx.now.getTime() - KEEP_MS))
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('kiosk_networks as n')
              .select('n.id')
              .whereRef('n.location_id', '=', 'r.location_id')
              .where(sql<boolean>`n.last_seen_at > r.first_seen_at`),
          ),
        ),
      )
      .orderBy('r.last_seen_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!row) return []
    return [
      {
        key: `kiosk_address_changed:${row.id}`,
        kind: 'kiosk_address_changed',
        tone: 'amber',
        title: 'The shop’s internet address may have changed',
        desc: `${row.name} was refused from a new address. A Super Admin can add it in Settings → Kiosk.`,
        actionLabel: 'Open Settings',
        appointmentId: null,
        priority: 1,
      },
    ]
  },
}
