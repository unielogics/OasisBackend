// /api/v1/kiosk/* (ADR 0180, api-spec section 31): the keypad (status, unlock), the unlocked kiosk's own reads and lock, and the
// manager's controls (team.roles): mode, code, devices, lockout, lock all, who shows on the kiosk.
import type { FastifyReply, FastifyRequest } from 'fastify'
import { access } from '../../http/access.js'
import { auditContextOf, isKioskContext, type KioskAuthContext } from '../../http/authorizer.js'
import type { AppInstance } from '../../http/types.js'
import { z } from '../../http/zod.js'
import { AppError } from '../../platform/errors.js'
import { sessionContext } from '../auth/context.js'
import {
  clearKioskSessionCookie,
  clearSessionCookie,
  sessionCookieName,
  setKioskDeviceCookie,
  setKioskSessionCookie,
} from '../auth/cookie.js'
import type { Identity } from '../auth/identity.js'
import { registerActivityReportRoutes } from './report.js'
import './problems.js'
import type { KioskAdmin } from './service.js'

export type KioskIdentityProvider = () => Promise<Identity>

const LockRule = z.enum(['closing', 'previous_day', 'two_hours'])

export const KioskPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  first: z.string(),
  initials: z.string(),
  avatarColor: z.string().nullable(),
  title: z.string(),
  bayStaff: z.boolean(),
})

export const KioskMeSchema = z.object({
  kind: z.literal('kiosk'),
  device: z.object({ id: z.string(), name: z.string() }),
  lock: z.object({ unlockedAt: z.string(), locksAt: z.string(), locksAtLabel: z.string(), rule: LockRule }),
  permissions: z.record(z.string(), z.object({ on: z.boolean() })),
  limits: z.record(z.string(), z.number().int().nullable()),
  csrfToken: z.string(),
  staff: z.array(KioskPersonSchema),
  businessTz: z.string(),
  serverTime: z.string(),
})

export const KioskStatusSchema = z.object({
  enabled: z.boolean(),
  device: z.object({ name: z.string() }).nullable(),
  unlocked: z.object({ locksAt: z.string(), locksAtLabel: z.string() }).nullable(),
  lockedOut: z.boolean(),
  retryAfterSec: z.number().int(),
})

export const KioskDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(['unlocked', 'locked', 'locked_out', 'revoked']),
  locksAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  lastIp: z.string().nullable(),
  lastUa: z.string().nullable(),
  failedAttempts: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  version: z.number().int(),
})

const EmployeeStatus = z.enum(['active', 'invited', 'inactive'])
const KioskStaffRow = z.object({ id: z.string(), name: z.string(), status: EmployeeStatus, listed: z.boolean() })

export const KioskOverviewSchema = z.object({
  enabled: z.boolean(),
  version: z.number().int(),
  code: z.object({
    set: z.boolean(),
    setAt: z.string().nullable(),
    setBy: z.string().nullable(),
    ageDays: z.number().int().nullable(),
  }),
  thisDeviceId: z.string().nullable(),
  devices: z.array(KioskDeviceSchema),
  staff: z.array(KioskStaffRow),
  recent: z.array(
    z.object({
      at: z.string(),
      action: z.string(),
      label: z.string(),
      by: z.string().nullable(),
      deviceName: z.string().nullable(),
    }),
  ),
})

const DeviceName = z.string().trim().min(1).max(40)
const IdParams = z.object({ id: z.string() })

const noStore = (reply: FastifyReply): void => void reply.header('Cache-Control', 'no-store')

const clientMeta = (req: FastifyRequest) => ({
  ip: req.ip,
  ua: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  requestId: req.id,
})

/** The unlocked kiosk behind the request, or 403 NOT_A_KIOSK (a signed-in person, or a test authorizer). */
function kioskOf(req: FastifyRequest): KioskAuthContext {
  if (!isKioskContext(req.auth)) throw new AppError('NOT_A_KIOSK')
  return req.auth
}

/** The signed-in manager behind an admin call (a kiosk never gets here: these routes are not on its list). */
function adminOf(req: FastifyRequest): KioskAdmin {
  const c = sessionContext(req)
  return {
    locationId: c.locationId,
    userId: c.userId,
    employeeId: c.employee.id,
    name: c.employee.displayName,
    sessionId: c.session.id,
    audit: auditContextOf(req),
  }
}

export function registerKioskRoutes(app: AppInstance, identityOf: KioskIdentityProvider): void {
  const kioskService = async () => (await identityOf()).kiosk

  // --- the keypad --------------------------------------------------------------------------------------------------------------

  app.get(
    '/kiosk/status',
    {
      config: {
        access: access.public(
          'Tells the sign-in page whether the keypad is on and whether this browser is a registered, unlocked kiosk; no personal data',
        ),
      },
      schema: {
        tags: ['kiosk'],
        summary: 'Kiosk mode on or off, and this browser’s kiosk state (device name, lock time, lockout, wait)',
        response: { 200: KioskStatusSchema },
      },
    },
    async (req, reply) => {
      noStore(reply)
      return (await kioskService()).status(req)
    },
  )

  app.post(
    '/kiosk/unlock',
    {
      config: {
        access: access.public(
          'The registered device cookie plus the shop code are the credential; per-device throttle and lockout, per-address and global limits',
        ),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['kiosk'],
        summary: 'Unlock this registered kiosk with the shop code; sets the kiosk session cookie until the lock time',
        description:
          '403 KIOSK_DEVICE_UNKNOWN (no live device cookie: the code is never checked); 409 KIOSK_OFF or KIOSK_CODE_NOT_SET; ' +
          '401 KIOSK_CODE_WRONG with meta.retryAfterSec; 429 KIOSK_THROTTLED with Retry-After (the code is not checked); ' +
          '423 KIOSK_LOCKED_OUT (20 wrong codes in a row: a manager clears it). Success ends the device’s previous kiosk session, signs ' +
          'out a user session on the device and sets the device cookie again (400 days).',
        body: z.object({ code: z.string().regex(/^\d{8}$/, 'Use exactly 8 digits') }).strict(),
        response: { 200: KioskMeSchema },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      const deviceToken = id.kiosk.deviceToken(req)
      const userCookie = sessionCookieName(app.env)
      const userSessionToken = req.cookies?.[userCookie]
      const r = await id.kiosk.unlock({ code: req.body.code, deviceToken, userSessionToken, meta: clientMeta(req) })
      setKioskSessionCookie(reply, app.env, r.token, (r.expiresAt.getTime() - id.clock.now().getTime()) / 1000)
      setKioskDeviceCookie(reply, app.env, deviceToken!)
      if (userSessionToken) clearSessionCookie(reply, app.env)
      noStore(reply)
      return r.me
    },
  )

  // --- the unlocked kiosk ------------------------------------------------------------------------------------------------------

  app.get(
    '/kiosk/me',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['kiosk'],
        summary: 'The unlocked kiosk: device, lock time, permissions, CSRF token and the employee picker list',
        description: '403 NOT_A_KIOSK for a signed-in person (their GET /me answers instead).',
        response: { 200: KioskMeSchema },
      },
    },
    async (req, reply) => {
      const ctx = kioskOf(req)
      noStore(reply)
      return (await kioskService()).me(ctx)
    },
  )

  app.get(
    '/kiosk/staff',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['kiosk'],
        summary: 'Who the employee picker lists: active or invited employees shown on the kiosk, bay staff first',
        description: '403 NOT_A_KIOSK for a signed-in person.',
        response: { 200: z.object({ items: z.array(KioskPersonSchema) }) },
      },
    },
    async (req) => {
      const ctx = kioskOf(req)
      return { items: await (await kioskService()).staff(ctx.locationId) }
    },
  )

  app.post(
    '/kiosk/lock',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['kiosk'],
        summary: 'Lock this kiosk now (the keypad shows again); clears the kiosk session cookie',
        description: '403 NOT_A_KIOSK for a signed-in person.',
      },
    },
    async (req, reply) => {
      const ctx = kioskOf(req)
      await (await kioskService()).lock(ctx, auditContextOf(req))
      clearKioskSessionCookie(reply, app.env)
      noStore(reply)
      return reply.status(204).send()
    },
  )

  // --- the manager's controls ----------------------------------------------------------------------------------------------------

  app.get(
    '/kiosk',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Settings → Kiosk: mode, code age, devices, who shows on the kiosk, recent kiosk events',
        response: { 200: KioskOverviewSchema },
      },
    },
    async (req, reply) => {
      const k = await kioskService()
      noStore(reply)
      return k.overview(adminOf(req), k.deviceToken(req))
    },
  )

  app.put(
    '/kiosk/settings',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Turn kiosk mode on or off',
        description:
          'Turning it on needs a shop code (409 KIOSK_CODE_NOT_SET); turning it off ends every kiosk session. Turning it on or off ' +
          'also signs out every manager signed in on a kiosk device (the caller too, when on one: the session cookie is cleared). ' +
          '`version` is the ' +
          'version GET /kiosk returned (412 VERSION_CONFLICT when it changed).',
        body: z.object({ enabled: z.boolean(), version: z.number().int().min(0) }).strict(),
        response: { 200: z.object({ enabled: z.boolean(), version: z.number().int() }) },
      },
    },
    async (req, reply) => {
      const r = await (await kioskService()).setEnabled(adminOf(req), req.body.enabled, req.body.version)
      if (r.signedOut) clearSessionCookie(reply, app.env)
      return { enabled: r.enabled, version: r.version }
    },
  )

  app.put(
    '/kiosk/code',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Set the shop code ({code}) or generate one ({generate: true}, shown once); locks every kiosk now',
        description:
          '8 digits, never starting with 0218, no repeats, runs, patterns, dates, common codes or one of the last 3 codes: 422 ' +
          'KIOSK_CODE_REJECTED with the rule in errors[0].message. The code is never stored or logged in clear.',
        body: z
          .object({ code: z.string().max(32).optional(), generate: z.literal(true).optional() })
          .strict()
          .refine((b) => (b.code === undefined) !== (b.generate === undefined), {
            message: 'Send either code or generate',
          }),
        response: { 200: z.object({ setAt: z.string(), code: z.string().optional() }) },
      },
    },
    async (req, reply) => {
      noStore(reply)
      return (await kioskService()).setCode(adminOf(req), req.body)
    },
  )

  app.post(
    '/kiosk/devices',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: '“Make this a kiosk”: register this browser; sets the device cookie (400 days)',
        description:
          '409 KIOSK_DEVICE_EXISTS when this browser already is a kiosk. While kiosk mode is on the manager’s own session ends ' +
          '(signedOut: true) and the browser goes to the keypad.',
        body: z.object({ name: DeviceName }).strict(),
        response: { 201: z.object({ device: KioskDeviceSchema, signedOut: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const k = await kioskService()
      const r = await k.registerDevice(adminOf(req), req.body.name, k.deviceToken(req), clientMeta(req))
      setKioskDeviceCookie(reply, app.env, r.token)
      if (r.signedOut) clearSessionCookie(reply, app.env)
      noStore(reply)
      return reply.status(201).send({ device: r.device, signedOut: r.signedOut })
    },
  )

  app.patch(
    '/kiosk/devices/:id',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Rename a kiosk device',
        params: IdParams,
        body: z.object({ name: DeviceName, version: z.number().int().min(1) }).strict(),
        response: { 200: KioskDeviceSchema },
      },
    },
    async (req) =>
      (await kioskService()).renameDevice(adminOf(req), req.params.id, req.body.name, req.body.version),
  )

  app.delete(
    '/kiosk/devices/:id',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Remove a kiosk device: its cookie stops working for good and its kiosk session ends',
        description: 'A manager signed in on the device is signed out too (the caller’s own session cookie is cleared when it was one).',
        params: IdParams,
      },
    },
    async (req, reply) => {
      const r = await (await kioskService()).revokeDevice(adminOf(req), req.params.id)
      if (r.signedOut) clearSessionCookie(reply, app.env)
      return reply.status(204).send()
    },
  )

  app.post(
    '/kiosk/devices/:id/lock',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Lock one kiosk now',
        description: 'A manager signed in on the device is signed out too.',
        params: IdParams,
      },
    },
    async (req, reply) => {
      const r = await (await kioskService()).lockDevice(adminOf(req), req.params.id)
      if (r.signedOut) clearSessionCookie(reply, app.env)
      return reply.status(204).send()
    },
  )

  app.post(
    '/kiosk/devices/:id/clear-lockout',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Clear a kiosk’s wrong-code lockout (the counter starts over)',
        params: IdParams,
        response: { 200: KioskDeviceSchema },
      },
    },
    async (req) => (await kioskService()).clearLockout(adminOf(req), req.params.id),
  )

  app.post(
    '/kiosk/lock-all',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Lock every kiosk now',
        description: '`locked` counts kiosk sessions. Every manager signed in on a kiosk device is signed out too.',
        response: { 200: z.object({ locked: z.number().int() }) },
      },
    },
    async (req, reply) => {
      const r = await (await kioskService()).lockAll(adminOf(req))
      if (r.signedOut) clearSessionCookie(reply, app.env)
      return { locked: r.locked }
    },
  )

  app.put(
    '/kiosk/staff/:employeeId',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: '“Shows on the kiosk”: whether the employee picker lists this person',
        params: z.object({ employeeId: z.string() }),
        body: z.object({ listed: z.boolean() }).strict(),
        response: { 200: KioskStaffRow },
      },
    },
    async (req) => (await kioskService()).setListed(adminOf(req), req.params.employeeId, req.body.listed),
  )

  registerActivityReportRoutes(app)
}
