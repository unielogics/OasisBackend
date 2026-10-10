// Loads the website's open-times board: the slot engine's answer for each of the next N business dates, for an online, non-VIP
// caller, projected by availability.ts. Reads the same rows the dashboard's availability reads (loadDayData).
import type { Executor } from '../../platform/db.js'
import { addDays, minutesOfDay, toBizDate } from '../../platform/time.js'
import { listCatalog, type CatalogService } from '../catalog/service.js'
import { computeSlots, type BusyInterval } from '../scheduling/availability.js'
import { engineInput, intervalOfRow, loadDayData } from '../scheduling/availability-loader.js'
import { boardDay, boardNow, type BoardView } from './availability.js'
import { keyServices } from './keys.js'

/** How many days the board may show at most: the standard online booking window is 14 days. */
export const BOARD_MAX_DAYS = 14
export const BOARD_DEFAULT_DAYS = 5

export interface BoardQuery {
  locationId: string
  tz: string
  now: Date
  days: number
  /** The website's service key; the first active package when absent. */
  serviceKey?: string
}

export interface BoardServices {
  packages: (CatalogService & { key: string })[]
  addons: (CatalogService & { key: string })[]
}

export async function loadBoardServices(db: Executor, locationId: string): Promise<BoardServices> {
  const c = await listCatalog(db, locationId)
  return { packages: keyServices(c.packages), addons: keyServices(c.addons) }
}

export async function loadBoard(
  db: Executor,
  q: BoardQuery,
  o: { services?: BoardServices } = {},
): Promise<BoardView | null> {
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
    const input = engineInput(data, { durationMin: pkg.durationMin, channel: 'online', isVip: false })
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
  return {
    tz: q.tz,
    generatedAt: q.now.toISOString(),
    serviceKey: pkg.key,
    durationMin: pkg.durationMin,
    now,
    days,
  }
}
