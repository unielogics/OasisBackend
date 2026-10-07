import type { SmsPriority } from '../../../integrations/ports/sms.js'
import { nextFit, type BudgetConfig, type UsagePoint } from './budget.js'
import { isTransactional } from '../policy/classes.js'
import { isQuietHour, quietHoursEnd, type QuietHoursConfig } from '../policy/quietHours.js'
import type { OutboxItem } from './types.js'

export interface ItemEta {
  id: string
  priority: SmsPriority
  /** Estimated send time; null when the message can never fit the budget. */
  at: Date | null
  /** The estimate lands after the message's expiry, so it will expire unsent. */
  willExpire: boolean
}

export interface QueueEstimate {
  depth: number
  byLane: Record<SmsPriority, number>
  oldestQueuedAt: Date | null
  etaFirst: Date | null
  etaLast: Date | null
  willExpire: number
  items: ItemEta[]
}

const order = (a: OutboxItem, b: OutboxItem): number =>
  a.priority - b.priority || a.queuedAt.getTime() - b.queuedAt.getTime() || (a.id < b.id ? -1 : 1)

/**
 * Walks the pending queue in dispatch order against the sliding window and the pacing interval and says when each message
 * would go out, assuming the device stays reachable. Quiet hours push non-transactional classes to the end of the window.
 */
export function estimateQueue(
  pending: readonly OutboxItem[],
  usage: readonly UsagePoint[],
  now: Date,
  budget: BudgetConfig,
  minIntervalMs: number,
  quiet: QuietHoursConfig,
): QueueEstimate {
  const sorted = [...pending].sort(order)
  const virtual: UsagePoint[] = [...usage]
  let lastAt = virtual.reduce((m, u) => Math.max(m, u.at.getTime()), Number.NEGATIVE_INFINITY)
  const byLane: Record<SmsPriority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
  const items: ItemEta[] = []

  for (const item of sorted) {
    byLane[item.priority] += 1
    let from = new Date(Math.max(now.getTime(), item.nextAttemptAt?.getTime() ?? 0, lastAt + minIntervalMs))
    if (!isTransactional(item.klass) && isQuietHour(from, quiet)) from = quietHoursEnd(from, quiet)
    const fit = nextFit(virtual, from, item.segments, item.priority, budget)
    let at = fit
    // The fit may land in quiet hours again for held classes; re-check once.
    if (at && !isTransactional(item.klass) && isQuietHour(at, quiet))
      at = nextFit(virtual, quietHoursEnd(at, quiet), item.segments, item.priority, budget)
    if (at) {
      virtual.push({ at, segments: item.segments })
      lastAt = Math.max(lastAt, at.getTime())
    }
    items.push({
      id: item.id,
      priority: item.priority,
      at,
      willExpire: at !== null && at.getTime() >= item.ttlAt.getTime(),
    })
  }

  const times = items.map((i) => i.at).filter((d): d is Date => d !== null)
  return {
    depth: sorted.length,
    byLane,
    oldestQueuedAt: sorted.reduce<Date | null>(
      (m, i) => (m === null || i.queuedAt < m ? i.queuedAt : m),
      null,
    ),
    etaFirst: times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null,
    etaLast: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
    willExpire: items.filter((i) => i.willExpire).length,
    items,
  }
}
