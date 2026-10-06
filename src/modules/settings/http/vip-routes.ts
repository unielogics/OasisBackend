// VIP program settings and reserved holds, and the arrival and check-in settings. The VIP client list lives in
// src/modules/customers/http/vip-clients.ts (it resolves customers).
import { access } from '../../../http/access.js'
import { z } from '../../../http/zod.js'
import type { Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { fmtT, tryParseT } from '../../../platform/time.js'
import { getArrivalSettings, saveArrivalSettings, type ArrivalSettings } from '../arrival.js'
import { DAY_NAMES } from '../labels.js'
import {
  addVipHold,
  CADENCES,
  CADENCE_LABELS,
  countVipClients,
  getVipSettings,
  holdToast,
  listVipHolds,
  removeVipHold,
  saveVipSettings,
  type VipHold,
  type VipSettings,
} from '../vip.js'
import { etag, expectedVersion, inTx, requestContext, storedUserId, type SettingsRuntime } from './runtime.js'

const HoldView = z.object({
  id: z.string(),
  weekday: z.number().int(),
  day: z.string(),
  timeMin: z.number().int(),
  time: z.string(),
  label: z.string().describe('"Saturday · 8:00 AM"'),
})

const holdView = (h: VipHold): z.infer<typeof HoldView> => ({
  id: h.id,
  weekday: h.weekday,
  day: DAY_NAMES[h.weekday]!,
  timeMin: h.timeMin,
  time: fmtT(h.timeMin),
  label: h.label,
})

const VipSettingsFields = {
  release: z.number().int().describe('Release unbooked holds this many hours before: 24, 48 or 72'),
  windowVip: z.number().int().describe('VIP booking window in days, 7 to 90'),
  windowStd: z.number().int().describe('Standard booking window in days, 7 to 60'),
  sameDay: z.number().int().describe('Same-day guarantee per VIP per month, 0 to 8'),
  waitlist: z.boolean(),
  offerMin: z.number().int().describe('Waitlist claim window: 10, 15 or 30 minutes'),
  standing: z.boolean(),
  autoConfirm: z.boolean(),
  cadences: z.array(z.enum(CADENCES)),
}

export const VipView = z.object({
  ...VipSettingsFields,
  cadenceOptions: z.array(z.object({ key: z.string(), label: z.string() })),
  holds: z.array(HoldView),
  counts: z.object({ clients: z.number().int(), holds: z.number().int() }),
  version: z.number().int(),
})

const vipFields = (s: VipSettings) => ({
  release: s.releaseHours,
  windowVip: s.windowVipDays,
  windowStd: s.windowStdDays,
  sameDay: s.sameDayPerMonth,
  waitlist: s.waitlist,
  offerMin: s.offerMinutes,
  standing: s.standing,
  autoConfirm: s.autoConfirm,
  cadences: s.cadences,
})

export async function loadVipView(db: Executor, locationId: string): Promise<z.infer<typeof VipView>> {
  const [{ settings, version }, holds, clients] = await Promise.all([
    getVipSettings(db, locationId),
    listVipHolds(db, locationId),
    countVipClients(db, locationId),
  ])
  return {
    ...vipFields(settings),
    cadenceOptions: CADENCES.map((key) => ({ key, label: CADENCE_LABELS[key] })),
    holds: holds.map(holdView),
    counts: { clients, holds: holds.length },
    version,
  }
}

const ArrivalFields = {
  on: z.boolean().describe('Geofence auto check-in'),
  radius: z.number().int().describe('Check-in radius in metres: 150, 300 or 500'),
  prepAt: z.number().int().describe('Prep-bay alert when the ETA is 10, 15 or 20 minutes away'),
  autoArrive: z.boolean(),
  welcome: z.boolean(),
  crew: z.boolean().describe('Alert the crew'),
  vipFirst: z.boolean(),
}

export const ArrivalView = z.object({ ...ArrivalFields, version: z.number().int() })

const arrivalFields = (s: ArrivalSettings) => ({
  on: s.enabled,
  radius: s.radiusM,
  prepAt: s.prepAtMin,
  autoArrive: s.autoArrive,
  welcome: s.welcome,
  crew: s.alertCrew,
  vipFirst: s.vipFirst,
})

export async function loadArrivalView(
  db: Executor,
  locationId: string,
): Promise<z.infer<typeof ArrivalView>> {
  const { settings, version } = await getArrivalSettings(db, locationId)
  return { ...arrivalFields(settings), version }
}

const Version = z.number().int().min(0).optional()

export function registerVipRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/vip',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getVip',
        summary: 'VIP program settings, reserved holds and counts (ETag = version)',
        response: { 200: VipView },
      },
    },
    async (req, reply) => {
      const v = await loadVipView(app.db, requestContext(req).locationId)
      etag(reply, v.version)
      return v
    },
  )

  app.put(
    '/vip',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: ['settings'],
        operationId: 'putVip',
        summary: 'Save VIP program settings (partial; each change saves immediately)',
        description:
          'Windows are ranges (7 to 90 and 7 to 60 days), not multiples of 7, because the design\'s own defaults 30 and 14 are off its stepper grid. `version` (or If-Match) is optional and enforced when sent. Publishes `settings.changed {section: "vip"}`.',
        body: z
          .object({
            release: VipSettingsFields.release.optional(),
            windowVip: VipSettingsFields.windowVip.optional(),
            windowStd: VipSettingsFields.windowStd.optional(),
            sameDay: VipSettingsFields.sameDay.optional(),
            waitlist: z.boolean().optional(),
            offerMin: VipSettingsFields.offerMin.optional(),
            standing: z.boolean().optional(),
            autoConfirm: z.boolean().optional(),
            cadences: z.array(z.enum(CADENCES)).optional(),
            version: Version,
          })
          .strict(),
        response: { 200: VipView.extend({ changed: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const b = req.body
      const patch: Partial<VipSettings> = {}
      if (b.release !== undefined) patch.releaseHours = b.release
      if (b.windowVip !== undefined) patch.windowVipDays = b.windowVip
      if (b.windowStd !== undefined) patch.windowStdDays = b.windowStd
      if (b.sameDay !== undefined) patch.sameDayPerMonth = b.sameDay
      if (b.waitlist !== undefined) patch.waitlist = b.waitlist
      if (b.offerMin !== undefined) patch.offerMinutes = b.offerMin
      if (b.standing !== undefined) patch.standing = b.standing
      if (b.autoConfirm !== undefined) patch.autoConfirm = b.autoConfirm
      if (b.cadences !== undefined) patch.cadences = b.cadences
      const out = await inTx(app.db, async (tx) => {
        const r = await saveVipSettings(tx, {
          locationId: c.locationId,
          patch,
          expectedVersion: expectedVersion(req, b.version),
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        })
        return { ...(await loadVipView(tx, c.locationId)), changed: r.changed }
      })
      etag(reply, out.version)
      return out
    },
  )

  app.post(
    '/vip/holds',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: ['settings'],
        operationId: 'addVipHold',
        summary: 'Reserve a weekly slot for VIPs',
        description:
          'A duplicate answers 409 VIP_HOLD_EXISTS with the design string "That slot is already held". `time` is "11:00 AM" or `timeMin` minutes; 5:00 AM to 11:30 PM in 30-minute steps.',
        body: z
          .object({
            weekday: z.number().int().min(0).max(6),
            time: z.string().max(12).optional(),
            timeMin: z.number().int().optional(),
          })
          .strict(),
        response: { 201: z.object({ hold: HoldView, toast: z.string() }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const timeMin = req.body.timeMin ?? (req.body.time !== undefined ? tryParseT(req.body.time) : null)
      if (timeMin === null)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Pick a time like 11:00 AM.',
          errors: [{ path: 'time', message: 'Pick a time like 11:00 AM.' }],
        })
      const hold = await inTx(app.db, (tx) =>
        addVipHold(tx, {
          locationId: c.locationId,
          weekday: req.body.weekday,
          timeMin,
          newId: app.newId,
          audit: c.audit,
        }),
      )
      return reply.status(201).send({ hold: holdView(hold), toast: holdToast(hold.weekday, hold.timeMin) })
    },
  )

  app.delete(
    '/vip/holds/:id',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: ['settings'],
        operationId: 'removeVipHold',
        summary: 'Release a reserved VIP slot',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ id: z.string(), removed: z.literal(true), hold: HoldView }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const hold = await inTx(app.db, (tx) =>
        removeVipHold(tx, { locationId: c.locationId, id: req.params.id, audit: c.audit }),
      )
      return { id: hold.id, removed: true as const, hold: holdView(hold) }
    },
  )

  app.get(
    '/arrival-settings',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getArrivalSettings',
        summary: 'Arrival and check-in settings (ETag = version)',
        response: { 200: ArrivalView },
      },
    },
    async (req, reply) => {
      const v = await loadArrivalView(app.db, requestContext(req).locationId)
      etag(reply, v.version)
      return v
    },
  )

  app.put(
    '/arrival-settings',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: ['settings'],
        operationId: 'putArrivalSettings',
        summary: 'Save arrival and check-in settings (partial; each change saves immediately)',
        description:
          '`version` (or If-Match) is optional and enforced when sent. Publishes `settings.changed {section: "arrival"}`.',
        body: z
          .object({
            on: z.boolean().optional(),
            radius: ArrivalFields.radius.optional(),
            prepAt: ArrivalFields.prepAt.optional(),
            autoArrive: z.boolean().optional(),
            welcome: z.boolean().optional(),
            crew: z.boolean().optional(),
            vipFirst: z.boolean().optional(),
            version: Version,
          })
          .strict(),
        response: { 200: ArrivalView.extend({ changed: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const b = req.body
      const patch: Partial<ArrivalSettings> = {}
      if (b.on !== undefined) patch.enabled = b.on
      if (b.radius !== undefined) patch.radiusM = b.radius
      if (b.prepAt !== undefined) patch.prepAtMin = b.prepAt
      if (b.autoArrive !== undefined) patch.autoArrive = b.autoArrive
      if (b.welcome !== undefined) patch.welcome = b.welcome
      if (b.crew !== undefined) patch.alertCrew = b.crew
      if (b.vipFirst !== undefined) patch.vipFirst = b.vipFirst
      const out = await inTx(app.db, async (tx) => {
        const r = await saveArrivalSettings(tx, {
          locationId: c.locationId,
          patch,
          expectedVersion: expectedVersion(req, b.version),
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        })
        return { ...(await loadArrivalView(tx, c.locationId)), changed: r.changed }
      })
      etag(reply, out.version)
      return out
    },
  )
}
