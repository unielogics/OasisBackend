// The open-times board of a personal link page (ADR 0160, design section 5): the website's board (src/modules/public/
// availability-loader.ts, the same slot engine and the same four states) evaluated for one client. Never cached: it is answered with
// `Cache-Control: no-store`, and it is VIP-aware only for a page whose number is verified and whose client holds the VIP rules (the
// staff's VIP list or an active member of the plan the website sells as VIP), never while a PIN reset holds member privileges.
import type { Executor } from '../../../platform/db.js'
import { addDays, minutesOfDay, toBizDate } from '../../../platform/time.js'
import { computeSlots, type BusyInterval } from '../../scheduling/availability.js'
import { engineInput, intervalOfRow, loadDayData } from '../../scheduling/availability-loader.js'
import { boardDay, boardNow, type BoardView } from '../availability.js'
import { BOARD_MAX_DAYS, loadBoardServices, type BoardServices } from '../availability-loader.js'

export interface LinkBoardQuery {
  locationId: string
  tz: string
  now: Date
  days: number
  /** A catalog key; the first package when absent. */
  serviceKey?: string
  /** Evaluate the slots with the VIP rules (VIP-held times are open to this client). */
  vip: boolean
}

/** The board for the page's client, or null for an unknown service key. */
export async function loadLinkBoard(db: Executor, q: LinkBoardQuery, o: { services?: BoardServices } = {}): Promise<BoardView | null> {
  const services = o.services ?? (await loadBoardServices(db, q.locationId))
  const pkg = q.serviceKey ? services.packages.find((p) => p.key === q.serviceKey) : services.packages[0]
  if (!pkg) return null
  const today = toBizDate(q.now, q.tz)
  const count = Math.min(Math.max(1, q.days), BOARD_MAX_DAYS)
  const days = []
  let now = { open: false, baysFree: 0, baysTotal: 0 }
  for (let d = 0; d < count; d++) {
    const date = addDays(today, d)
    const data = await loadDayData(db, { locationId: q.locationId, tz: q.tz, now: q.now, date })
    const input = engineInput(data, { durationMin: pkg.durationMin, channel: 'online', isVip: q.vip })
    days.push(boardDay({ result: computeSlots(input), reason: data.day.reason, reduced: data.day.reduced, today }))
    if (d === 0) {
      const nowMin = minutesOfDay(q.now, q.tz)
      const openNow =
        !data.day.closed && data.day.openMin !== null && data.day.closeMin !== null && nowMin >= data.day.openMin && nowMin < data.day.closeMin
      const intervals = data.rows
        .map((r) => intervalOfRow(r, data.settings.rules.bufferMinutes, q.now, data.vipIds.has(r.customerId)))
        .filter((x): x is BusyInterval => x !== null)
      now = boardNow({ openNow, activeBays: data.activeBays, intervals, now: q.now })
    }
  }
  return { tz: q.tz, generatedAt: q.now.toISOString(), serviceKey: pkg.key, durationMin: pkg.durationMin, now, days }
}
