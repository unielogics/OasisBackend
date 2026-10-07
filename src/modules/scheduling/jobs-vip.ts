// vip.hold_release_scan: tells the dashboard when a VIP hold lets go. The availability engine already decides at query
// time (a hold is vip_held while now < slot start - release hours), so nothing here changes what a booking sees; the scan
// exists so open screens refetch the day the moment its held slot becomes bookable, instead of at their next poll.
// vip_hold_releases records each (hold, slot) once, so a repeat run, a second worker or a retry announces nothing new.
// The waitlist (P2, not built) would be offered the slot here as well.
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db } from '../../platform/db.js'
import type { JobDefinition } from '../../platform/jobs.js'
import * as realtime from '../../platform/realtime.js'
import { addDays, bizWeekday, toBizDate, wallToInstant } from '../../platform/time.js'
import '../settings/schema.js'

export const VIP_HOLD_RELEASE_JOB = 'vip.hold_release_scan'

const DEFAULT_RELEASE_HOURS = 48
/** Release is at most 72 hours before the slot, so slots up to 4 days ahead can be inside their release window. */
const LOOKAHEAD_DAYS = 4

export interface VipReleaseResult {
  locationId: string
  /** Slots whose release was announced by this run. */
  released: Array<{ date: string; timeMin: number; holdId: string }>
}

export async function runVipHoldReleaseScan(db: Db, clock: Clock): Promise<VipReleaseResult[]> {
  const now = clock.now()
  const out: VipReleaseResult[] = []
  for (const loc of await db
    .selectFrom('locations')
    .select(['id', 'timezone'])
    .orderBy('created_at')
    .orderBy('id')
    .execute()) {
    const settings = await db
      .selectFrom('vip_settings')
      .select('release_hours')
      .where('location_id', '=', loc.id)
      .executeTakeFirst()
    const releaseMs = (settings?.release_hours ?? DEFAULT_RELEASE_HOURS) * 3_600_000
    const holds = await db
      .selectFrom('vip_holds')
      .select(['id', 'weekday', 'time_min'])
      .where('location_id', '=', loc.id)
      .execute()
    const result: VipReleaseResult = { locationId: loc.id, released: [] }
    out.push(result)
    if (holds.length === 0) continue

    const today = toBizDate(now, loc.timezone)
    const due: Array<{ holdId: string; slotStart: Date; date: string; timeMin: number }> = []
    for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
      const date = addDays(today, i)
      const weekday = bizWeekday(date)
      for (const h of holds) {
        if (h.weekday !== weekday) continue
        const slotStart = wallToInstant(date, h.time_min, loc.timezone)
        const releasesAt = slotStart.getTime() - releaseMs
        if (releasesAt <= now.getTime() && slotStart.getTime() > now.getTime())
          due.push({ holdId: h.id, slotStart, date, timeMin: h.time_min })
      }
    }
    if (due.length === 0) continue

    await transaction(db, async (tx) => {
      const dates = new Set<string>()
      for (const d of due) {
        const r = await tx
          .insertInto('vip_hold_releases')
          .values({ hold_id: d.holdId, slot_start: d.slotStart, location_id: loc.id, released_at: now })
          .onConflict((oc) => oc.columns(['hold_id', 'slot_start']).doNothing())
          .returning('hold_id')
          .executeTakeFirst()
        if (!r) continue
        result.released.push({ date: d.date, timeMin: d.timeMin, holdId: d.holdId })
        dates.add(d.date)
      }
      for (const date of [...dates].sort())
        await realtime.publish(tx, {
          locationId: loc.id,
          channel: 'ops',
          type: 'availability.changed',
          payload: { date },
        })
    })
  }
  return out
}

export const vipHoldReleaseJob: JobDefinition = {
  name: VIP_HOLD_RELEASE_JOB,
  cron: '*/5 * * * *',
  policy: 'short',
  retryLimit: 1,
  retryDelaySeconds: 30,
  expireInSeconds: 4 * 60,
  async handler(ctx) {
    const results = await runVipHoldReleaseScan(ctx.db, ctx.clock)
    const released = results.reduce((n, r) => n + r.released.length, 0)
    if (released > 0) ctx.logger.info({ released }, 'vip hold slots released')
  },
}
