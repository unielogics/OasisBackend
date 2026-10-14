// /api/v1/kiosk/* (ADR 0180 and its 2026-10-14 amendment, api-spec section 31): the keypad (status, unlock with an employee's PIN at
// the shop's network), the unlocked kiosk's own reads and lock, and the manager's controls (team.roles): mode, employees' PINs, shop
// browsers, lockouts, lock all, who shows on the kiosk; the shop's networks are added, removed and approved by a Super Admin only.
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
  openedBy: z
    .object({ id: z.string().nullable(), name: z.string() })
    .describe('Whose PIN opened this kiosk session ("Opened by Marco R.")'),
  permissions: z.record(z.string(), z.object({ on: z.boolean() })),
  limits: z.record(z.string(), z.number().int().nullable()),
  csrfToken: z.string(),
  staff: z.array(KioskPersonSchema),
  businessTz: z.string(),
  serverTime: z.string(),
})

export const KioskStatusSchema = z.object({
  enabled: z.boolean(),
  networkSet: z.boolean().describe('At least one shop network exists (else: "A Super Admin must set the shop network first")'),
  atShop: z.boolean().describe('The caller’s address is a shop network (else: "PINs work only at the shop")'),
  unlocked: z.object({ locksAt: z.string(), locksAtLabel: z.string() }).nullable(),
  lockedOut: z.boolean(),
  retryAfterSec: z.number().int(),
})

export const KioskDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(['unlocked', 'locked', 'locked_out', 'revoked']),
  locksAt: z.string().nullable(),
  openedBy: z.string().nullable().describe('While unlocked: whose PIN opened it'),
  lastSeenAt: z.string().nullable(),
  lastIp: z.string().nullable(),
  lastUa: z.string().nullable(),
  failedAttempts: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  version: z.number().int(),
})

export const KioskNetworkSchema = z.object({
  id: z.string(),
  address: z.string().describe('An IPv4 address ("203.0.113.7") or an IPv6 /64 prefix ("2001:db8:1:2::/64")'),
  label: z.string().nullable(),
  addedBy: z.string().nullable(),
  addedAt: z.string(),
  lastSeenAt: z
    .string()
    .nullable()
    .describe('The last time it was in use: a PIN, an unlocked kiosk or the keypad from it (updated at most every 5 minutes)'),
  failedAttempts: z.number().int(),
  lockedOut: z.boolean(),
})

export const KioskRefusedSchema = z.object({
  id: z.string(),
  address: z.string().describe('What POST /kiosk/networks {address} approves'),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  attempts: z.number().int(),
  fromKnownBrowser: z
    .boolean()
    .describe('A try carried the cookie of a browser that unlocked at the shop before: the shop’s address probably changed'),
  browserName: z.string().nullable(),
  shopActiveSince: z
    .boolean()
    .describe(
      'A shop network was in use after this address was first refused: the shop’s usual address still works, so this is not the provider changing it',
    ),
})

const EmployeeStatus = z.enum(['active', 'invited', 'inactive'])
const KioskListedRow = z.object({ id: z.string(), name: z.string(), status: EmployeeStatus, listed: z.boolean() })
const KioskStaffRow = KioskListedRow.extend({
  pin: z.object({ setAt: z.string(), setBy: z.string().nullable() }).nullable().describe('Whether they have a PIN (never the PIN)'),
})

export const KioskOverviewSchema = z.object({
  enabled: z.boolean(),
  version: z.number().int(),
  yourAddress: z.string().nullable().describe('The caller’s internet address as the server sees it'),
  yourAddressIsShop: z.boolean(),
  canManageNetworks: z.boolean().describe('The caller is a Super Admin: adds, removes and approves shop networks'),
  networks: z.array(KioskNetworkSchema),
  refused: z.array(KioskRefusedSchema).describe('PINs tried from an unknown network (30 days, at most 50), newest first'),
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

/**
 * The signed-in manager behind an admin call (a kiosk never gets here: these routes are not on its list). `isSuper` is the same flag
 * every SUPER_ONLY rule reads (people/guards.ts requireSuper): the person holds the locked Super Admin role AND is not viewing as a
 * lesser role, so view-as can only narrow, never widen.
 */
function adminOf(req: FastifyRequest): KioskAdmin {
  const c = sessionContext(req)
  return {
    locationId: c.locationId,
    userId: c.userId,
    employeeId: c.employee.id,
    name: c.employee.displayName,
    sessionId: c.session.id,
    isSuper: c.isSuper,
    ip: req.ip,
    audit: auditContextOf(req),
  }
}

const PinBody = z
  .object({ pin: z.string().max(32).optional(), generate: z.literal(true).optional() })
  .strict()
  .refine((b) => (b.pin === undefined) !== (b.generate === undefined), { message: 'Send either pin or generate' })

const NetworkBody = z
  .object({
    label: z.string().trim().min(1).max(60).nullable().optional(),
    confirmAddress: z
      .string()
      .max(64)
      .optional()
      .describe('“This is the shop’s network”: the address GET /kiosk showed as yourAddress; the caller’s address is added'),
    address: z.string().max(64).optional().describe('Approve this address of the refused list (from anywhere)'),
  })
  .strict()
  .refine((b) => (b.confirmAddress === undefined) !== (b.address === undefined), {
    message: 'Send either confirmAddress or address',
  })

export function registerKioskRoutes(app: AppInstance, identityOf: KioskIdentityProvider): void {
  const kioskService = async () => (await identityOf()).kiosk

  // --- the keypad --------------------------------------------------------------------------------------------------------------

  app.get(
    '/kiosk/status',
    {
      config: {
        access: access.public(
          'Tells the sign-in page whether the keypad is on, whether PINs work from this address and whether this browser is unlocked; no personal data',
        ),
      },
      schema: {
        tags: ['kiosk'],
        summary: 'Kiosk mode on or off, whether a shop network is set and the caller is on it, and this browser’s state (lock time, lockout, wait)',
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
          'An employee’s PIN from a shop network address is the credential (never evaluated from anywhere else); per-address and per-browser throttle and lockout, a global limit',
        ),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['kiosk'],
        summary: 'Unlock the kiosk with an employee’s PIN at the shop; sets the kiosk session cookie until the lock time',
        description:
          '409 KIOSK_OFF; 403 KIOSK_NOT_AT_SHOP with meta.networkSet when the caller’s address is in no shop network (the PIN is ' +
          'never checked; the try is listed for the Super Admin); 401 KIOSK_PIN_WRONG with meta.retryAfterSec (never says whether ' +
          'someone else has the PIN); 429 KIOSK_THROTTLED with Retry-After (the PIN is not checked); 423 KIOSK_LOCKED_OUT (too many ' +
          'wrong PINs from this address or this browser: a manager clears it). Success opens the kiosk for everyone, recorded as ' +
          'opened by the PIN’s employee; ends this browser’s previous kiosk session; signs out a user session on it; and sets the ' +
          'device cookie (400 days), a new one at a browser’s first unlock ("Shop browser N").',
        body: z.object({ pin: z.string().regex(/^\d{8}$/, 'Use exactly 8 digits') }).strict(),
        response: { 200: KioskMeSchema },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      const deviceToken = id.kiosk.deviceToken(req)
      const userCookie = sessionCookieName(app.env)
      const userSessionToken = req.cookies?.[userCookie]
      const r = await id.kiosk.unlock({ pin: req.body.pin, deviceToken, userSessionToken, meta: clientMeta(req) })
      setKioskSessionCookie(reply, app.env, r.token, (r.expiresAt.getTime() - id.clock.now().getTime()) / 1000)
      setKioskDeviceCookie(reply, app.env, r.deviceToken)
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
        summary:
          'Settings → Kiosk: mode, the caller’s address and whether it is a shop network, the shop networks, PINs tried from unknown ' +
          'networks, shop browsers, who shows on the kiosk and who has a PIN, recent kiosk events',
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
          'On by default. Turning it off ends every kiosk session. Turning it on or off also signs out every manager signed in on a ' +
          'kiosk browser (the caller too, when on one: the session cookie is cleared). ' +
          '`version` is the ' +
          'version GET /kiosk returned (412 VERSION_CONFLICT when it changed).',
        body: z.object({ enabled: z.boolean(), version: z.number().int().min(0) }).strict(),
        response: {
          200: z.object({
            enabled: z.boolean(),
            version: z.number().int(),
            signedOut: z.boolean().describe('The caller was signed in on a kiosk device and is signed out (the browser goes to the keypad)'),
          }),
        },
      },
    },
    async (req, reply) => {
      const r = await (await kioskService()).setEnabled(adminOf(req), req.body.enabled, req.body.version)
      if (r.signedOut) clearSessionCookie(reply, app.env)
      return { enabled: r.enabled, version: r.version, signedOut: r.signedOut }
    },
  )

  app.patch(
    '/kiosk/devices/:id',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Rename a shop browser',
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
        summary: 'Remove a shop browser: its cookie stops working for good and its kiosk session ends',
        description:
          'A manager signed in on it is signed out too (the caller’s own session cookie is cleared when it was one). A PIN typed on ' +
          'that browser later, at the shop, makes it a new shop browser.',
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
        description: 'A manager signed in on that browser is signed out too.',
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
        summary: 'Clear a browser’s wrong-PIN lockout (the counter starts over)',
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
        description: '`locked` counts kiosk sessions. Every manager signed in on a kiosk browser is signed out too.',
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
        summary: '“Shows on the kiosk”: whether the employee picker lists this person (a hidden person’s PIN does not unlock either)',
        params: z.object({ employeeId: z.string() }),
        body: z.object({ listed: z.boolean() }).strict(),
        response: { 200: KioskListedRow },
      },
    },
    async (req) => (await kioskService()).setListed(adminOf(req), req.params.employeeId, req.body.listed),
  )

  app.put(
    '/kiosk/staff/:employeeId/pin',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Set an employee’s kiosk PIN ({pin}) or generate one ({generate: true}, shown once)',
        description:
          '8 digits, never starting with 0218, no repeats, runs, patterns, dates or common PINs, not used by anyone else in the shop ' +
          '(a neutral "Choose another PIN") and not one of that employee’s last 3: 422 KIOSK_PIN_REJECTED with the rule in ' +
          'errors[0].message. 409 KIOSK_PIN_INACTIVE for a deactivated employee; 404 for someone not of the shop. The PIN is never ' +
          'stored or logged in clear; the tablet stays open.',
        params: z.object({ employeeId: z.string() }),
        body: PinBody,
        response: { 200: z.object({ employeeId: z.string(), setAt: z.string(), pin: z.string().optional() }) },
      },
    },
    async (req, reply) => {
      noStore(reply)
      return (await kioskService()).setPin(adminOf(req), req.params.employeeId, req.body)
    },
  )

  app.delete(
    '/kiosk/staff/:employeeId/pin',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Remove an employee’s kiosk PIN (nothing to do when they have none)',
        params: z.object({ employeeId: z.string() }),
      },
    },
    async (req, reply) => {
      await (await kioskService()).removePin(adminOf(req), req.params.employeeId)
      return reply.status(204).send()
    },
  )

  // --- the shop's networks (adding, removing and approving: Super Admin only) ---------------------------------------------------

  app.post(
    '/kiosk/networks',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Add a shop network: this connection’s address ({confirmAddress}) or an address of the refused list ({address})',
        description:
          'Super Admin only (403 SUPER_ONLY otherwise, in addition to team.roles; viewing as a lesser role does not count). ' +
          '{confirmAddress}: “This is the shop’s network”, from any device on the shop’s Wi-Fi: adds the caller’s own address (an ' +
          'IPv4 address, or its IPv6 /64), only when it still equals the address the screen showed (409 KIOSK_ADDRESS_CHANGED with ' +
          'meta.yourAddress otherwise, e.g. a phone that switched to mobile data; it cannot detect an address that was never the ' +
          'shop’s, such as a VPN or iCloud Private Relay, see runbook section 11). {address}: approves a "PIN tried from a new network" ' +
          'entry, from anywhere (404 KIOSK_REFUSED_UNKNOWN for any other address). 201 when added, 200 when it already was one.',
        body: NetworkBody,
        response: {
          201: z.object({ network: KioskNetworkSchema, created: z.literal(true) }),
          200: z.object({ network: KioskNetworkSchema, created: z.literal(false) }),
        },
      },
    },
    async (req, reply) => {
      const r = await (await kioskService()).addNetwork(adminOf(req), req.body)
      return reply.status(r.created ? 201 : 200).send(r)
    },
  )

  app.delete(
    '/kiosk/networks/:id',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Remove a shop network: PINs stop working from it (open kiosks stay open until they lock)',
        description: 'Super Admin only (403 SUPER_ONLY otherwise, in addition to team.roles).',
        params: IdParams,
      },
    },
    async (req, reply) => {
      await (await kioskService()).removeNetwork(adminOf(req), req.params.id)
      return reply.status(204).send()
    },
  )

  app.post(
    '/kiosk/networks/:id/clear-lockout',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['kiosk'],
        summary: 'Clear a shop address’s wrong-PIN lockout (the counter starts over)',
        params: IdParams,
        response: { 200: KioskNetworkSchema },
      },
    },
    async (req) => (await kioskService()).clearNetworkLockout(adminOf(req), req.params.id),
  )

  registerActivityReportRoutes(app)
}
