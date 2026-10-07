// Emergency close and reopen as application commands, shared by the routes and the auto-reopen jobs. Each runs inside
// the caller's transaction; the jobs and the idempotent POST handler own the transaction.
import type { Executor, Tx } from '../../../platform/db.js'
import type { Clock } from '../../../platform/clock.js'
import { AppError } from '../../../platform/errors.js'
import type * as audit from '../../../platform/audit.js'
import type { NewId } from '../../../platform/ids.js'
import { minutesOfDay, toBizDate } from '../../../platform/time.js'
import { dayInfo } from '../day-info.js'
import {
  closeShop,
  getActiveEmergency,
  reopenShop,
  type CloseShopInput,
  type CloseShopResult,
  type ReopenResult,
} from '../emergency.js'
import { listLiveClosures } from '../closures.js'
import { getHours } from '../hours.js'
import type { SettingsPorts } from './runtime.js'
import './problems.js'

/**
 * "Rest of today" once the shop has closed (or on a day it is not open at all) has nothing to close (review B38): reject
 * with a clear error instead of writing a closure for a day that is already over.
 */
export async function assertTodayClosable(
  tx: Executor,
  o: { locationId: string; now: Date; tz: string },
): Promise<void> {
  const today = toBizDate(o.now, o.tz)
  const [hours, closures] = await Promise.all([
    getHours(tx, o.locationId),
    listLiveClosures(tx, o.locationId, { from: today, to: today }),
  ])
  const info = dayInfo({ date: today, hours, closures, emergency: null })
  if (info.closed || minutesOfDay(o.now, o.tz) >= (info.closeMin ?? 0))
    throw new AppError('EMERGENCY_NOTHING_TO_CLOSE')
}

export interface CloseCommand extends Pick<
  CloseShopInput,
  'reason' | 'duration' | 'message' | 'notify' | 'link' | 'credits' | 'pause' | 'crew'
> {
  locationId: string
  startedBy: string | null
  startedByName: string | null
  audit?: audit.AuditContext
}

export async function closeCommand(
  tx: Tx,
  d: { clock: Clock; newId: NewId; tz: string; ports: SettingsPorts; linkEnabled: boolean },
  cmd: CloseCommand,
): Promise<CloseShopResult> {
  const now = d.clock.now()
  // an active emergency answers 409 first; its own closure row would otherwise read as "already closed"
  if (await getActiveEmergency(tx, cmd.locationId)) throw new AppError('EMERGENCY_ACTIVE')
  if (cmd.duration.kind === 'today')
    await assertTodayClosable(tx, { locationId: cmd.locationId, now, tz: d.tz })
  return closeShop(tx, {
    ...cmd,
    now,
    tz: d.tz,
    newId: d.newId,
    notifier: d.ports.emergencyNotifier,
    effects: d.ports.emergencyEffects({ clock: d.clock, newId: d.newId, tz: d.tz }),
    linkEnabled: d.linkEnabled,
  })
}

/** Reopens the shop. The service publishes the single ops event (`emergency.reopened`), so every path (person, job) announces once. */
export async function reopenCommand(
  tx: Tx,
  d: { clock: Clock; tz: string },
  cmd: {
    locationId: string
    reopenedBy?: string | null
    reopenedByName?: string | null
    auto?: boolean
    audit?: audit.AuditContext
  },
): Promise<ReopenResult> {
  return reopenShop(tx, { ...cmd, now: d.clock.now(), tz: d.tz })
}

/** Job path: reopens the active emergency when its end time has passed (and, when given, only that emergency). */
export async function reopenIfDue(
  tx: Tx,
  d: { clock: Clock; tz: string },
  o: { locationId: string; emergencyClosureId?: string },
): Promise<ReopenResult | undefined> {
  const active = await getActiveEmergency(tx, o.locationId)
  if (!active) return undefined
  if (o.emergencyClosureId && active.id !== o.emergencyClosureId) return undefined
  if (!active.endsAt || active.endsAt.getTime() > d.clock.now().getTime()) return undefined
  return reopenCommand(tx, d, { locationId: o.locationId, auto: true })
}
