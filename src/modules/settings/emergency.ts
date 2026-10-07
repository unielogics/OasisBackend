// Emergency closure: window and summary math (pure), message rendering, and the close/reopen state machine with history.
// Notification fan-out and the crew/credit effects sit behind ports; every number shown is computed from rows.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { advisoryXactLock } from '../../platform/db.js'
import { AppError, registerProblems } from '../../platform/errors.js'
import * as audit from '../../platform/audit.js'
import * as realtime from '../../platform/realtime.js'
import { shortCode, type NewId } from '../../platform/ids.js'
import {
  addDays,
  bizDayBounds,
  bizWeekday,
  diffDays,
  fmtT,
  isValidBizDate,
  minutesOfDay,
  toBizDate,
  wallToInstant,
} from '../../platform/time.js'
import './schema.js'
import type { EmergencyDurationKind, EmergencyReason, NotificationState } from './schema.js'
import { listAppointmentsInRange } from './affected.js'
import { recordChange } from './changes.js'
import { toClosure, listLiveClosures, type ClosureRecord } from './closures.js'
import { dayInfo, type DayInfo, type EmergencySnapshot } from './day-info.js'
import { getHours, type HoursDay } from './hours.js'
import {
  DEFAULT_EMERGENCY_MESSAGE,
  EMERGENCY_DURATION_KINDS,
  EMERGENCY_REASONS,
  EMERGENCY_REASON_KEYS,
  mediumDate,
  weekdayMonthDay,
} from './labels.js'
import {
  queueOnlyNotifier,
  type AffectedAppointment,
  type EmergencyEffects,
  type EmergencyNotifier,
} from './ports.js'

registerProblems({
  EMERGENCY_ACTIVE: {
    status: 409,
    title: 'Already closed',
    detail: 'An emergency closure is already active. Reopen the shop first',
  },
  EMERGENCY_NOT_ACTIVE: {
    status: 409,
    title: 'Not closed',
    detail: 'There is no active emergency closure',
  },
})

export const MAX_CLOSED_DAYS = 60
export const PREVIEW_SAMPLE = { first: 'Liam', link: 'oasis.spa/r/8KQ2' } as const
const LINK_VALIDITY_DAYS = 14

export interface EmergencyDuration {
  kind: EmergencyDurationKind
  /** "Reopen at", minutes from midnight (kind until). */
  untilMin?: number | null
  /** "Closed through", business date (kind days). */
  throughDate?: string | null
}

// Pure --------------------------------------------------------------------------------------------------------------

/** "for the rest of today", "until 2:00 PM today" or "through Monday, Jun 15". */
export function untilText(d: EmergencyDuration): string {
  if (d.kind === 'today') return 'for the rest of today'
  if (d.kind === 'until') return `until ${fmtT(d.untilMin ?? 0)} today`
  return `through ${weekdayMonthDay(d.throughDate ?? '')}`
}

/** "{reason} · closed {untilText}{ · online booking paused}" with the reason chip label. */
export function emergencySummary(reason: EmergencyReason, d: EmergencyDuration, pause: boolean): string {
  return `${EMERGENCY_REASONS[reason].label} · closed ${untilText(d)}${pause ? ' · online booking paused' : ''}`
}

/** Removes every sentence of the template that contains {link} (used while reschedule links are disabled). */
export function stripLinkSentences(template: string): string {
  const parts = template.split(/(?<=[.!?])(\s+)/)
  const kept: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i]!
    if (sentence.includes('{link}')) continue
    kept.push(sentence)
  }
  return kept.join(' ').trim()
}

export interface MessageVars {
  first: string
  reason: string
  until: string
  link?: string | null
}

/**
 * Renders {first} {reason} {until} {link}, each replaced globally. When links are disabled (the include-link switch is
 * off, or no reschedule landing page exists yet) the sentence containing {link} is removed instead of leaving a dead
 * placeholder (resolves the design's open question).
 */
export function renderEmergencyMessage(template: string, vars: MessageVars, linkEnabled: boolean): string {
  const text = linkEnabled && vars.link ? template : stripLinkSentences(template)
  return text
    .replace(/\{first\}/g, vars.first)
    .replace(/\{reason\}/g, vars.reason)
    .replace(/\{until\}/g, vars.until)
    .replace(/\{link\}/g, vars.link ?? '')
}

export interface EmergencyWindow {
  startDate: string
  throughDate: string
  untilMin: number | null
  endsAt: Date
  /** Appointment starts in [affectedFrom, affectedTo) are affected. */
  affectedFrom: Date
  affectedTo: Date
}

function badInput(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })
}

/**
 * Today = from the start of the business day to its end; until = start of day to the reopening time (must be later than
 * now); days = start of today to the end of the last date, including future days.
 */
export function emergencyWindow(o: {
  duration: EmergencyDuration
  now: Date
  tz: string
  hours: readonly HoursDay[]
}): EmergencyWindow {
  const { duration: d, now, tz } = o
  const startDate = toBizDate(now, tz)
  const dayStart = bizDayBounds(startDate, tz).start
  const closeOf = (date: string): Date => {
    const h = o.hours.find((x) => x.weekday === bizWeekday(date))
    return h?.isOpen ? wallToInstant(date, h.closeMin, tz) : bizDayBounds(date, tz).end
  }
  if (d.kind === 'today') {
    const close = closeOf(startDate)
    const end = bizDayBounds(startDate, tz).end
    return {
      startDate,
      throughDate: startDate,
      untilMin: null,
      endsAt: close.getTime() > now.getTime() ? close : end,
      affectedFrom: dayStart,
      affectedTo: end,
    }
  }
  if (d.kind === 'until') {
    const m = d.untilMin
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > 1439)
      throw badInput('until', 'Pick a time to reopen.')
    const at = wallToInstant(startDate, m, tz)
    if (at.getTime() <= now.getTime())
      throw badInput('until', 'Pick a reopening time that is later than now.')
    return {
      startDate,
      throughDate: startDate,
      untilMin: m,
      endsAt: at,
      affectedFrom: dayStart,
      affectedTo: at,
    }
  }
  const through = d.throughDate ?? ''
  if (!isValidBizDate(through) || through < startDate || diffDays(startDate, through) > MAX_CLOSED_DAYS)
    throw badInput('through', `Pick a date from today to ${MAX_CLOSED_DAYS} days out.`)
  const close = closeOf(through)
  return {
    startDate,
    throughDate: through,
    untilMin: null,
    endsAt: close.getTime() > now.getTime() ? close : bizDayBounds(through, tz).end,
    affectedFrom: dayStart,
    affectedTo: bizDayBounds(through, tz).end,
  }
}

/** The closure rows an emergency writes: one per open date, closed or reduced to the window that stays open. */
export function emergencyClosureRows(o: {
  duration: EmergencyDuration
  window: EmergencyWindow
  hours: readonly HoursDay[]
  now: Date
  tz: string
}): { date: string; type: 'closed' | 'reduced'; openMin: number | null; closeMin: number | null }[] {
  const rows: {
    date: string
    type: 'closed' | 'reduced'
    openMin: number | null
    closeMin: number | null
  }[] = []
  const nowMin = minutesOfDay(o.now, o.tz)
  for (let date = o.window.startDate; date <= o.window.throughDate; date = addDays(date, 1)) {
    const h = o.hours.find((x) => x.weekday === bizWeekday(date))
    if (!h || !h.isOpen) continue
    const first = date === o.window.startDate
    if (o.duration.kind === 'today' && first && nowMin > h.openMin && nowMin < h.closeMin) {
      rows.push({ date, type: 'reduced', openMin: h.openMin, closeMin: nowMin })
    } else if (o.duration.kind === 'until') {
      const m = o.window.untilMin!
      if (m <= h.openMin) continue
      if (m >= h.closeMin) rows.push({ date, type: 'closed', openMin: null, closeMin: null })
      else rows.push({ date, type: 'reduced', openMin: m, closeMin: h.closeMin })
    } else rows.push({ date, type: 'closed', openMin: null, closeMin: null })
  }
  return rows
}

// Repository ---------------------------------------------------------------------------------------------------------

export interface EmergencyRecord {
  id: string
  locationId: string
  active: boolean
  reason: EmergencyReason
  durationKind: EmergencyDurationKind
  untilMin: number | null
  throughDate: string | null
  endsAt: Date | null
  message: string
  notify: boolean
  link: boolean
  credits: boolean
  pause: boolean
  crew: boolean
  summary: string
  startedAt: Date
  startedBy: string | null
  startedByName: string | null
  reopenedAt: Date | null
  reopenedBy: string | null
  reopenedByName: string | null
  autoReopened: boolean
  affectedCount: number
  notifiedCount: number
  rebookedCount: number
  detail: string | null
  replacedClosureIds: string[]
}

const EM_COLUMNS = [
  'id',
  'location_id',
  'active',
  'reason',
  'duration_kind',
  'until_min',
  'through_date',
  'ends_at',
  'message',
  'notify',
  'link',
  'credits',
  'pause',
  'crew',
  'summary',
  'started_at',
  'started_by',
  'started_by_name',
  'reopened_at',
  'reopened_by',
  'reopened_by_name',
  'auto_reopened',
  'affected_count',
  'notified_count',
  'rebooked_count',
  'detail',
  'replaced_closure_ids',
] as const

type EmRow = {
  id: string
  location_id: string
  active: boolean
  reason: EmergencyReason
  duration_kind: EmergencyDurationKind
  until_min: number | null
  through_date: string | null
  ends_at: Date | null
  message: string
  notify: boolean
  link: boolean
  credits: boolean
  pause: boolean
  crew: boolean
  summary: string
  started_at: Date
  started_by: string | null
  started_by_name: string | null
  reopened_at: Date | null
  reopened_by: string | null
  reopened_by_name: string | null
  auto_reopened: boolean
  affected_count: number
  notified_count: number
  rebooked_count: number
  detail: string | null
  replaced_closure_ids: string[]
}

const toEmergency = (r: EmRow): EmergencyRecord => ({
  id: r.id,
  locationId: r.location_id,
  active: r.active,
  reason: r.reason,
  durationKind: r.duration_kind,
  untilMin: r.until_min,
  throughDate: r.through_date,
  endsAt: r.ends_at,
  message: r.message,
  notify: r.notify,
  link: r.link,
  credits: r.credits,
  pause: r.pause,
  crew: r.crew,
  summary: r.summary,
  startedAt: r.started_at,
  startedBy: r.started_by,
  startedByName: r.started_by_name,
  reopenedAt: r.reopened_at,
  reopenedBy: r.reopened_by,
  reopenedByName: r.reopened_by_name,
  autoReopened: r.auto_reopened,
  affectedCount: r.affected_count,
  notifiedCount: r.notified_count,
  rebookedCount: r.rebooked_count,
  detail: r.detail,
  replacedClosureIds: r.replaced_closure_ids,
})

export async function getActiveEmergency(
  db: Executor,
  locationId: string,
): Promise<EmergencyRecord | undefined> {
  const r = await db
    .selectFrom('emergency_closures')
    .select([...EM_COLUMNS])
    .where('location_id', '=', locationId)
    .where('active', '=', true)
    .executeTakeFirst()
  return r ? toEmergency(r) : undefined
}

export async function getEmergency(
  db: Executor,
  locationId: string,
  id: string,
): Promise<EmergencyRecord | undefined> {
  const r = await db
    .selectFrom('emergency_closures')
    .select([...EM_COLUMNS])
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst()
  return r ? toEmergency(r) : undefined
}

/** The slice dayInfo needs, derived from the active row (null when no emergency is active). */
export function emergencySnapshot(
  e: EmergencyRecord | undefined | null,
  tz: string,
): EmergencySnapshot | null {
  if (!e || !e.active) return null
  const startDate = toBizDate(e.startedAt, tz)
  return {
    active: true,
    reason: e.reason,
    durationKind: e.durationKind,
    untilMin: e.untilMin,
    startDate,
    throughDate: e.throughDate ?? startDate,
    pause: e.pause,
  }
}

export interface EmergencyCounters {
  affected: number
  notified: number
  skipped: number
  rebooked: number
}

/** Counters from real rows: notified = queued, sent or delivered; rebooked = distinct appointments that rebooked. */
export async function liveCounters(db: Executor, emergencyClosureId: string): Promise<EmergencyCounters> {
  const r = await sql<{ affected: number; notified: number; skipped: number; rebooked: number }>`
    select
      (select count(*)::int from appointments where emergency_closure_id = ${emergencyClosureId}) as affected,
      (select count(*)::int from emergency_notifications
         where emergency_closure_id = ${emergencyClosureId} and state in ('queued', 'sent', 'delivered')) as notified,
      (select count(*)::int from emergency_notifications
         where emergency_closure_id = ${emergencyClosureId} and state in ('skipped_opt_out', 'no_contact', 'failed')) as skipped,
      (select count(*)::int from (
         select appointment_id from emergency_notifications
           where emergency_closure_id = ${emergencyClosureId} and rebooked_at is not null
         union
         select appointment_id from reschedule_links
           where emergency_closure_id = ${emergencyClosureId} and used_at is not null
       ) x) as rebooked`.execute(db)
  return r.rows[0]!
}

// Preview ------------------------------------------------------------------------------------------------------------

export interface EmergencyInput {
  locationId: string
  reason: EmergencyReason
  duration: EmergencyDuration
  message?: string | null
  notify: boolean
  link: boolean
  credits: boolean
  pause: boolean
  crew: boolean
  now: Date
  tz: string
}

function validateInput(i: EmergencyInput): void {
  if (!EMERGENCY_REASON_KEYS.includes(i.reason)) throw badInput('reason', 'Pick a reason.')
  if (!EMERGENCY_DURATION_KINDS.includes(i.duration.kind))
    throw badInput('duration', 'Pick how long to close for.')
  if ((i.message ?? '').length > 1000) throw badInput('message', 'Keep the message under 1000 characters.')
}

const AFFECTED_STATUSES = ['booked', 'confirmed'] as const
const ON_SITE_STATUSES = ['arrived', 'cleaning'] as const

export interface EmergencyPreview {
  count: number
  affected: AffectedAppointment[]
  /** Vehicles already on site; reported, never touched. */
  onSite: AffectedAppointment[]
  summary: string
  untilText: string
  renderedMessage: string
  window: EmergencyWindow
}

/** GET /emergency/preview: who would be affected and the message as it would read (design sample name and link). */
export async function previewEmergency(
  db: Executor,
  input: EmergencyInput & { linkEnabled: boolean; sample?: { first: string; link: string } },
): Promise<EmergencyPreview> {
  validateInput(input)
  const hours = await getHours(db, input.locationId)
  const window = emergencyWindow({ duration: input.duration, now: input.now, tz: input.tz, hours })
  const [affected, onSite] = await Promise.all([
    listAppointmentsInRange(db, {
      locationId: input.locationId,
      from: window.affectedFrom,
      to: window.affectedTo,
      statuses: AFFECTED_STATUSES,
      tz: input.tz,
    }),
    listAppointmentsInRange(db, {
      locationId: input.locationId,
      from: window.affectedFrom,
      to: bizDayBounds(window.startDate, input.tz).end,
      statuses: ON_SITE_STATUSES,
      tz: input.tz,
    }),
  ])
  const duration: EmergencyDuration = {
    ...input.duration,
    untilMin: window.untilMin,
    throughDate: window.throughDate,
  }
  const text = untilText(duration)
  const sample = input.sample ?? PREVIEW_SAMPLE
  return {
    count: affected.length,
    affected,
    onSite,
    summary: emergencySummary(input.reason, duration, input.pause),
    untilText: text,
    renderedMessage: renderEmergencyMessage(
      input.message?.trim() ? input.message : DEFAULT_EMERGENCY_MESSAGE,
      { first: sample.first, reason: EMERGENCY_REASONS[input.reason].phrase, until: text, link: sample.link },
      input.link && input.linkEnabled,
    ),
    window,
  }
}

// Close ---------------------------------------------------------------------------------------------------------------

export interface CloseShopInput extends EmergencyInput {
  newId: NewId
  notifier?: EmergencyNotifier
  effects?: EmergencyEffects
  /** RESCHEDULE_LINK_ENABLED: false strips the link sentence even when the include-link switch is on. */
  linkEnabled: boolean
  /** Base of the short link, e.g. "oasis.spa/r"; the code is appended. */
  linkBase?: string
  startedBy?: string | null
  startedByName?: string | null
  audit?: audit.AuditContext
}

export interface NotifiedAppointment extends AffectedAppointment {
  notification: { channel: 'sms' | 'email' | 'none'; state: NotificationState }
}

export interface CloseShopResult {
  emergency: EmergencyRecord
  summary: string
  notifiedCount: number
  skipped: number
  affected: NotifiedAppointment[]
  onSite: AffectedAppointment[]
  closuresCreated: ClosureRecord[]
}

function channelFor(a: AffectedAppointment): {
  channel: 'sms' | 'email' | 'none'
  state?: NotificationState
} {
  if (a.phoneE164 && !a.smsOptedOut) return { channel: 'sms' }
  if (a.email) return { channel: 'email' }
  return { channel: 'none', state: a.phoneE164 && a.smsOptedOut ? 'skipped_opt_out' : 'no_contact' }
}

/**
 * POST /emergency/close in one transaction: rejects a second active emergency, writes the emergency row and the closure
 * rows (replacing planned ones, remembered for restore), flags the affected booked/confirmed appointments, creates
 * reschedule links, fans the message out through the notifier and stores the real counters.
 */
export async function closeShop(tx: Tx, input: CloseShopInput): Promise<CloseShopResult> {
  validateInput(input)
  await advisoryXactLock(tx, `emergency:${input.locationId}`)
  if (await getActiveEmergency(tx, input.locationId)) throw new AppError('EMERGENCY_ACTIVE')

  const hours = await getHours(tx, input.locationId)
  const window = emergencyWindow({ duration: input.duration, now: input.now, tz: input.tz, hours })
  const duration: EmergencyDuration = {
    ...input.duration,
    untilMin: window.untilMin,
    throughDate: window.throughDate,
  }
  const text = untilText(duration)
  const summary = emergencySummary(input.reason, duration, input.pause)
  const template = input.message?.trim() ? input.message : DEFAULT_EMERGENCY_MESSAGE
  const emergencyId = input.newId()

  await tx
    .insertInto('emergency_closures')
    .values({
      id: emergencyId,
      location_id: input.locationId,
      active: true,
      reason: input.reason,
      duration_kind: input.duration.kind,
      until_min: window.untilMin,
      through_date: window.throughDate,
      ends_at: window.endsAt,
      message: template,
      notify: input.notify,
      link: input.link,
      credits: input.credits,
      pause: input.pause,
      crew: input.crew,
      summary,
      started_at: input.now,
      started_by: input.startedBy ?? null,
      started_by_name: input.startedByName ?? null,
      reopened_at: null,
      reopened_by: null,
      reopened_by_name: null,
      detail: null,
    })
    .execute()

  const replaced: string[] = []
  const created: ClosureRecord[] = []
  for (const row of emergencyClosureRows({ duration, window, hours, now: input.now, tz: input.tz })) {
    const existing = await tx
      .selectFrom('closures')
      .select('id')
      .where('location_id', '=', input.locationId)
      .where('date', '=', row.date)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst()
    if (existing) {
      replaced.push(existing.id)
      await tx
        .updateTable('closures')
        .set((eb) => ({ deleted_at: eb.fn('app_now', []), updated_at: eb.fn('app_now', []) }))
        .where('id', '=', existing.id)
        .execute()
    }
    const id = input.newId()
    await tx
      .insertInto('closures')
      .values({
        id,
        location_id: input.locationId,
        date: row.date,
        name: EMERGENCY_REASONS[input.reason].closureName,
        type: row.type,
        open_min: row.openMin,
        close_min: row.closeMin,
        notify: false,
        source: 'emergency',
        federal_key: null,
        federal_year: null,
        emergency_closure_id: emergencyId,
        created_by: input.startedBy ?? null,
        deleted_at: null,
      })
      .execute()
    const c = await tx
      .selectFrom('closures')
      .select([
        'id',
        'location_id',
        'date',
        'name',
        'type',
        'open_min',
        'close_min',
        'notify',
        'source',
        'federal_key',
        'federal_year',
        'emergency_closure_id',
        'deleted_at',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    created.push(toClosure(c))
  }

  const [affected, onSite] = await Promise.all([
    listAppointmentsInRange(tx, {
      locationId: input.locationId,
      from: window.affectedFrom,
      to: window.affectedTo,
      statuses: AFFECTED_STATUSES,
      tz: input.tz,
    }),
    listAppointmentsInRange(tx, {
      locationId: input.locationId,
      from: window.affectedFrom,
      to: bizDayBounds(window.startDate, input.tz).end,
      statuses: ON_SITE_STATUSES,
      tz: input.tz,
    }),
  ])

  const effectiveLink = input.link && input.linkEnabled
  const notifier = input.notifier ?? queueOnlyNotifier
  const linkBase = (input.linkBase ?? 'oasis.spa/r').replace(/\/+$/, '')
  const expires = new Date(
    Math.max(window.endsAt.getTime(), input.now.getTime()) + LINK_VALIDITY_DAYS * 86_400_000,
  )
  const reasonPhrase = EMERGENCY_REASONS[input.reason].phrase
  const out: NotifiedAppointment[] = []

  if (affected.length > 0) {
    await tx
      .updateTable('appointments')
      .set((eb) => ({
        emergency_closure_id: emergencyId,
        version: eb('version', '+', 1),
        updated_at: eb.fn('app_now', []),
      }))
      .where(
        'id',
        'in',
        affected.map((a) => a.appointmentId),
      )
      .execute()
  }

  for (const a of affected) {
    let linkId: string | null = null
    let code: string | null = null
    if (effectiveLink) {
      linkId = input.newId()
      code = shortCode(12)
      await tx
        .insertInto('reschedule_links')
        .values({
          id: linkId,
          code,
          appointment_id: a.appointmentId,
          emergency_closure_id: emergencyId,
          closure_id: null,
          expires_at: expires,
          used_at: null,
          result_appointment_id: null,
        })
        .execute()
    }
    if (!input.notify) {
      out.push({ ...a, notification: { channel: 'none', state: 'no_contact' } })
      continue
    }
    const plan = channelFor(a)
    let state: NotificationState
    let messageId: string | null = null
    if (plan.channel === 'none') state = plan.state!
    else {
      const res = await notifier.send(tx, {
        locationId: input.locationId,
        emergencyClosureId: emergencyId,
        appointment: a,
        channel: plan.channel,
        message: renderEmergencyMessage(
          template,
          {
            first: a.firstName,
            reason: reasonPhrase,
            until: text,
            link: code ? `${linkBase}/${code}` : null,
          },
          effectiveLink,
        ),
        rescheduleLinkId: linkId,
        rescheduleCode: code,
        priority: 0,
      })
      state = res.state
      messageId = res.messageId ?? null
    }
    await tx
      .insertInto('emergency_notifications')
      .values({
        id: input.newId(),
        emergency_closure_id: emergencyId,
        appointment_id: a.appointmentId,
        customer_id: a.customerId,
        message_id: messageId,
        channel: plan.channel,
        state,
        reschedule_link_id: linkId,
        rebooked_at: null,
      })
      .execute()
    out.push({ ...a, notification: { channel: plan.channel, state } })
  }

  if (input.credits && affected.length > 0)
    await input.effects?.protectCredits?.(tx, {
      emergencyClosureId: emergencyId,
      appointmentIds: affected.map((a) => a.appointmentId),
    })
  if (input.crew)
    await input.effects?.alertCrew?.(tx, {
      emergencyClosureId: emergencyId,
      locationId: input.locationId,
      summary,
    })

  const counters = await liveCounters(tx, emergencyId)
  await tx
    .updateTable('emergency_closures')
    .set({
      affected_count: affected.length,
      notified_count: counters.notified,
      rebooked_count: 0,
      replaced_closure_ids: replaced,
    })
    .where('id', '=', emergencyId)
    .execute()
  const emergency = (await getEmergency(tx, input.locationId, emergencyId))!
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'emergency.close',
    entityType: 'emergency_closure',
    entityId: emergencyId,
    after: {
      reason: input.reason,
      summary,
      affected: affected.length,
      notified: counters.notified,
      notify: input.notify,
      pause: input.pause,
    },
    section: 'emergency',
    audit: input.audit,
    channel: 'ops',
    eventType: 'emergency.started',
    payload: { id: emergencyId, summary, pause: input.pause },
  })
  await realtime.publish(tx, {
    locationId: input.locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: 'emergency', key: emergencyId },
  })
  return {
    emergency,
    summary,
    notifiedCount: counters.notified,
    skipped: counters.skipped,
    affected: out,
    onSite,
    closuresCreated: created,
  }
}

// Reopen --------------------------------------------------------------------------------------------------------------

export interface ReopenInput {
  locationId: string
  now: Date
  tz: string
  reopenedBy?: string | null
  reopenedByName?: string | null
  /** True when the end time passed and the job reopened the shop. */
  auto?: boolean
  audit?: audit.AuditContext
}

export interface ReopenResult {
  emergency: EmergencyRecord
  detail: string
  restoredClosureIds: string[]
  removedClosureIds: string[]
}

/**
 * POST /emergency/reopen: freezes the counters into the history row, soft-deletes today's and future emergency closure
 * rows, restores the planned closures they replaced (those dated today or later) and resumes online booking. Customers
 * who did not rebook stay flagged on their appointments; nothing is canceled.
 */
export async function reopenShop(tx: Tx, input: ReopenInput): Promise<ReopenResult> {
  await advisoryXactLock(tx, `emergency:${input.locationId}`)
  const active = await tx
    .selectFrom('emergency_closures')
    .select([...EM_COLUMNS])
    .where('location_id', '=', input.locationId)
    .where('active', '=', true)
    .forUpdate()
    .executeTakeFirst()
  if (!active) throw new AppError('EMERGENCY_NOT_ACTIVE')
  const em = toEmergency(active)
  const today = toBizDate(input.now, input.tz)

  const rows = await tx
    .selectFrom('closures')
    .select('id')
    .where('emergency_closure_id', '=', em.id)
    .where('deleted_at', 'is', null)
    .where('date', '>=', today)
    .execute()
  const removed = rows.map((r) => r.id)
  if (removed.length > 0) {
    await tx
      .updateTable('closures')
      .set((eb) => ({ deleted_at: eb.fn('app_now', []), updated_at: eb.fn('app_now', []) }))
      .where('id', 'in', removed)
      .execute()
  }
  let restored: string[] = []
  if (em.replacedClosureIds.length > 0) {
    const candidates = await tx
      .selectFrom('closures')
      .select('id')
      .where('id', 'in', em.replacedClosureIds)
      .where('deleted_at', 'is not', null)
      .where('date', '>=', today)
      .execute()
    restored = candidates.map((c) => c.id)
    if (restored.length > 0) {
      await tx
        .updateTable('closures')
        .set((eb) => ({ deleted_at: null, updated_at: eb.fn('app_now', []) }))
        .where('id', 'in', restored)
        .execute()
    }
  }

  const counters = await liveCounters(tx, em.id)
  const who = input.auto ? 'automatically' : `by ${input.reopenedByName ?? 'staff'}`
  const detail = `Reopened ${who} · ${counters.notified} notified`
  await tx
    .updateTable('emergency_closures')
    .set({
      active: false,
      reopened_at: input.now,
      reopened_by: input.reopenedBy ?? null,
      reopened_by_name: input.auto ? null : (input.reopenedByName ?? null),
      auto_reopened: input.auto ?? false,
      affected_count: counters.affected,
      notified_count: counters.notified,
      rebooked_count: counters.rebooked,
      detail,
    })
    .where('id', '=', em.id)
    .execute()
  const emergency = (await getEmergency(tx, input.locationId, em.id))!
  await recordChange(tx, {
    locationId: input.locationId,
    action: input.auto ? 'emergency.auto_reopen' : 'emergency.reopen',
    entityType: 'emergency_closure',
    entityId: em.id,
    before: { active: true, summary: em.summary },
    after: { active: false, detail, rebooked: counters.rebooked },
    section: 'emergency',
    audit: input.audit,
    channel: 'ops',
    eventType: 'emergency.reopened',
    payload: { id: em.id, auto: input.auto ?? false },
  })
  await realtime.publish(tx, {
    locationId: input.locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: 'emergency', key: em.id },
  })
  return { emergency, detail, restoredClosureIds: restored, removedClosureIds: removed }
}

/** Job entry point: reopens an active emergency whose end time has passed; returns undefined when nothing was due. */
export async function reopenIfEnded(
  tx: Tx,
  input: Omit<ReopenInput, 'auto'>,
): Promise<ReopenResult | undefined> {
  const active = await getActiveEmergency(tx, input.locationId)
  if (!active?.endsAt || active.endsAt.getTime() > input.now.getTime()) return undefined
  return reopenShop(tx, { ...input, auto: true })
}

// State ---------------------------------------------------------------------------------------------------------------

export interface ShopStrip {
  /** Open right now: today's day info is open and now is inside its window. */
  openNow: boolean
  today: DayInfo
  /** Booked and confirmed appointments still to come today. */
  appointmentsRemaining: number
  /** Arrived or cleaning, plus completed jobs waiting for pickup. */
  vehiclesOnSite: number
}

export interface EmergencyHistoryItem {
  id: string
  /** "Jun 3, 2026". */
  date: string
  reason: string
  detail: string
  affectedCount: number
  notifiedCount: number
  rebookedCount: number
}

export interface EmergencyView {
  id: string
  reason: EmergencyReason
  reasonLabel: string
  durationKind: EmergencyDurationKind
  untilMin: number | null
  throughDate: string | null
  endsAt: Date | null
  summary: string
  startedAt: Date
  startedByName: string | null
  message: string
  notify: boolean
  link: boolean
  credits: boolean
  pause: boolean
  crew: boolean
  counters: { affected: number; notified: number; rebooked: number; booking: 'Paused' | 'Open' }
}

export interface EmergencyState {
  active: boolean
  current: EmergencyView | null
  history: EmergencyHistoryItem[]
  strip: ShopStrip
}

function durationDetail(e: EmergencyRecord, tz: string): string {
  if (e.durationKind === 'today') return 'Full day'
  if (e.durationKind === 'until') return `Until ${fmtT(e.untilMin ?? 0)}`
  return `Through ${mediumDate(e.throughDate ?? toBizDate(e.startedAt, tz))}`
}

/** GET /emergency: banner state, live counters, the idle strip numbers and the history (newest first). */
export async function getEmergencyState(
  db: Executor,
  o: { locationId: string; now: Date; tz: string; historyLimit?: number },
): Promise<EmergencyState> {
  const today = toBizDate(o.now, o.tz)
  const [active, hours, closures] = await Promise.all([
    getActiveEmergency(db, o.locationId),
    getHours(db, o.locationId),
    listLiveClosures(db, o.locationId, { from: today, to: today }),
  ])
  const info = dayInfo({ date: today, hours, closures, emergency: emergencySnapshot(active, o.tz) })
  const nowMin = minutesOfDay(o.now, o.tz)
  const { start, end } = bizDayBounds(today, o.tz)
  const counts = await sql<{ remaining: number; onsite: number }>`
    select
      count(*) filter (where status in ('booked', 'confirmed'))::int as remaining,
      count(*) filter (where status in ('arrived', 'cleaning')
                         or (status = 'completed' and pickup_state = 'pending'))::int as onsite
    from appointments
    where location_id = ${o.locationId} and scheduled_start >= ${start} and scheduled_start < ${end}`.execute(
    db,
  )
  const strip: ShopStrip = {
    openNow: !info.closed && nowMin >= info.openMin! && nowMin < info.closeMin!,
    today: info,
    appointmentsRemaining: counts.rows[0]!.remaining,
    vehiclesOnSite: counts.rows[0]!.onsite,
  }
  let current: EmergencyView | null = null
  if (active) {
    const c = await liveCounters(db, active.id)
    current = {
      id: active.id,
      reason: active.reason,
      reasonLabel: EMERGENCY_REASONS[active.reason].label,
      durationKind: active.durationKind,
      untilMin: active.untilMin,
      throughDate: active.throughDate,
      endsAt: active.endsAt,
      summary: active.summary,
      startedAt: active.startedAt,
      startedByName: active.startedByName,
      message: active.message,
      notify: active.notify,
      link: active.link,
      credits: active.credits,
      pause: active.pause,
      crew: active.crew,
      counters: {
        affected: c.affected,
        notified: c.notified,
        rebooked: c.rebooked,
        booking: active.pause ? 'Paused' : 'Open',
      },
    }
  }
  const history = await listEmergencyHistory(db, o.locationId, o.tz, o.historyLimit)
  return { active: active !== undefined, current, history, strip }
}

export async function listEmergencyHistory(
  db: Executor,
  locationId: string,
  tz: string,
  limit = 50,
): Promise<EmergencyHistoryItem[]> {
  const rows = await db
    .selectFrom('emergency_closures')
    .select([...EM_COLUMNS])
    .where('location_id', '=', locationId)
    .where('active', '=', false)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute()
  return rows.map(toEmergency).map((e) => ({
    id: e.id,
    date: mediumDate(toBizDate(e.startedAt, tz)),
    reason: EMERGENCY_REASONS[e.reason].label,
    detail: e.detail ?? `${durationDetail(e, tz)} · ${e.notifiedCount} notified`,
    affectedCount: e.affectedCount,
    notifiedCount: e.notifiedCount,
    rebookedCount: e.rebookedCount,
  }))
}

/** GET /emergency/:id/affected: appointments flagged by that emergency that still need a new time. */
export async function listNeedsRebooking(
  db: Executor,
  o: { locationId: string; emergencyClosureId: string; tz: string },
): Promise<AffectedAppointment[]> {
  const rows = await sql<{ id: string }>`
    select a.id from appointments a
    where a.location_id = ${o.locationId} and a.emergency_closure_id = ${o.emergencyClosureId}
      and a.status in ('booked', 'confirmed')
      and not exists (select 1 from emergency_notifications n
                      where n.appointment_id = a.id and n.emergency_closure_id = a.emergency_closure_id and n.rebooked_at is not null)
      and not exists (select 1 from reschedule_links l
                      where l.appointment_id = a.id and l.emergency_closure_id = a.emergency_closure_id and l.used_at is not null)
    order by a.scheduled_start, a.id`.execute(db)
  return listAppointmentsInRange(db, {
    locationId: o.locationId,
    ids: rows.rows.map((r) => r.id),
    statuses: ['booked', 'confirmed'],
    tz: o.tz,
  })
}
