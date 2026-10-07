// /api/v1/auth/* and /api/v1/me*: sign-in, sessions, invites, password flows, preferences, view-as.
import type { FastifyReply, FastifyRequest } from 'fastify'
import { access } from '../../http/access.js'
import { auditContextOf } from '../../http/authorizer.js'
import { z } from '../../http/zod.js'
import type { AppInstance } from '../../http/types.js'
import * as audit from '../../platform/audit.js'
import { transaction } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { PERMISSIONS } from '../rbac/catalog.js'
import { roleLimit } from '../rbac/engine.js'
import { loadGrants } from '../rbac/repository.js'
import { sessionContext, initials, type SessionAuthContext } from './context.js'
import { clearSessionCookie, sessionCookieName, setSessionCookie } from './cookie.js'
import type { Identity } from './identity.js'
import { csrfTokenFor } from './tokens.js'

export type IdentityProvider = () => Promise<Identity>

const Email = z.string().trim().min(3).max(254)
const NewEmail = z.string().trim().email().max(254)
const Password = z.string().min(1).max(256)

export const SignedInResponse = z.object({
  user: z.object({ id: z.string(), employeeId: z.string(), email: z.string(), name: z.string() }),
  csrfToken: z.string(),
})

const PermissionState = z.object({ on: z.boolean(), limit: z.number().int().nullable().optional() })

export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string() }),
  employee: z.object({
    id: z.string(),
    first: z.string(),
    last: z.string(),
    name: z.string(),
    initials: z.string(),
    title: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    avatarColor: z.string().nullable(),
  }),
  roles: z.array(z.object({ id: z.string(), key: z.string().nullable(), name: z.string() })),
  displayRole: z.string(),
  isSuperAdmin: z.boolean(),
  permissions: z.record(z.string(), PermissionState),
  limits: z.record(z.string(), z.number().int().nullable()),
  rbacVersion: z.number().int(),
  preferences: z.object({ theme: z.enum(['light', 'dark']).nullable() }),
  viewAs: z.object({
    active: z.boolean(),
    canViewAs: z.boolean(),
    roleId: z.string().nullable(),
    roleName: z.string().nullable(),
    options: z.array(
      z.object({
        id: z.string(),
        key: z.string().nullable(),
        name: z.string(),
        locked: z.boolean(),
        limits: z.record(z.string(), z.number().int().nullable()),
      }),
    ),
  }),
  csrfToken: z.string(),
  session: z.object({ expiresAt: z.string() }),
})

const noStore = (reply: FastifyReply): void => void reply.header('Cache-Control', 'no-store')

const clientMeta = (req: FastifyRequest) => ({
  ip: req.ip,
  ua: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  requestId: req.id,
})

export async function buildMe(
  identity: Identity,
  ctx: SessionAuthContext,
): Promise<z.infer<typeof MeResponse>> {
  const prefs = await identity.db
    .selectFrom('user_preferences')
    .select('theme')
    .where('user_id', '=', ctx.userId)
    .executeTakeFirst()
  const a = ctx.authority
  const permissions: z.infer<typeof MeResponse>['permissions'] = {}
  for (const p of PERMISSIONS) {
    const e = a.effective[p.key]!
    permissions[p.key] = e.on
      ? e.limit !== undefined
        ? { on: true, limit: e.limit }
        : { on: true }
      : { on: false }
  }
  let options: z.infer<typeof MeResponse>['viewAs']['options'] = []
  if (ctx.canViewAs) {
    const grants = await loadGrants(identity.db)
    const meta = await identity.db.selectFrom('roles').select(['id', 'is_locked']).execute()
    const locked = new Map(meta.map((m) => [m.id, m.is_locked]))
    options = grants.map((g) => ({
      id: g.id,
      key: g.key,
      name: g.name,
      locked: locked.get(g.id) ?? false,
      limits: {
        refund: roleLimit(g, 'refund'),
        adjust: roleLimit(g, 'adjust'),
        credit: roleLimit(g, 'credit'),
      },
    }))
  }
  const e = ctx.employee
  return {
    user: { id: ctx.userId, email: ctx.email },
    employee: {
      id: e.id,
      first: e.first,
      last: e.last,
      name: e.displayName,
      initials: initials(e.first, e.last),
      title: e.title,
      phone: e.phone,
      email: e.email,
      avatarColor: e.avatarColor,
    },
    roles: a.roles.map((r) => ({ id: r.id, key: r.key, name: r.name })),
    displayRole: ctx.viewAsRole?.name ?? a.roles[0]?.name ?? '',
    isSuperAdmin: ctx.canViewAs,
    permissions,
    limits: Object.fromEntries(Object.entries(a.limits).map(([k, v]) => [k, v ?? null])) as Record<
      string,
      number | null
    >,
    rbacVersion: ctx.rbacVersion,
    preferences: { theme: prefs?.theme ?? null },
    viewAs: {
      active: !!ctx.viewAsRole,
      canViewAs: ctx.canViewAs,
      roleId: ctx.viewAsRole?.id ?? null,
      roleName: ctx.viewAsRole?.name ?? null,
      options,
    },
    csrfToken: csrfTokenFor(ctx.session.csrfSecret, ctx.session.id),
    session: { expiresAt: ctx.session.absoluteExpiresAt.toISOString() },
  }
}

export function registerAuthRoutes(app: AppInstance, identityOf: IdentityProvider): void {
  const cookieName = sessionCookieName(app.env)
  const signedIn = async (
    reply: FastifyReply,
    r: {
      session: { token: string; expiresAt: Date; csrfToken: string }
      user: z.infer<typeof SignedInResponse>['user']
    },
  ) => {
    const { clock } = await identityOf()
    setSessionCookie(
      reply,
      app.env,
      r.session.token,
      (r.session.expiresAt.getTime() - clock.now().getTime()) / 1000,
    )
    noStore(reply)
    return { user: r.user, csrfToken: r.session.csrfToken }
  }

  app.post(
    '/auth/login',
    {
      config: {
        access: access.public('Sign-in; throttled per IP and per account with a progressive delay'),
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password; sets the session cookie',
        body: z.object({ email: Email, password: Password }).strict(),
        response: { 200: SignedInResponse },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      const r = await id.auth.login({
        ...req.body,
        currentToken: req.cookies?.[cookieName],
        ...clientMeta(req),
      })
      return signedIn(reply, r)
    },
  )

  app.post(
    '/auth/logout',
    {
      config: { access: access.authenticated() },
      schema: { tags: ['auth'], summary: 'Revoke the current session and clear the cookie' },
    },
    async (req, reply) => {
      const ctx = sessionContext(req)
      const id = await identityOf()
      await id.auth.logout(
        ctx.session.id,
        { userId: ctx.userId, employeeId: ctx.employee.id, name: ctx.employee.displayName },
        clientMeta(req),
      )
      clearSessionCookie(reply, app.env)
      noStore(reply)
      return reply.status(204).send()
    },
  )

  app.get(
    '/auth/csrf',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['auth'],
        summary: 'The synchronizer token to send as X-CSRF-Token on unsafe requests',
        response: { 200: z.object({ csrfToken: z.string() }) },
      },
    },
    async (req, reply) => {
      const ctx = sessionContext(req)
      noStore(reply)
      return { csrfToken: csrfTokenFor(ctx.session.csrfSecret, ctx.session.id) }
    },
  )

  app.post(
    '/auth/invite/accept',
    {
      config: {
        access: access.public('Accepts a one-time invite token; the token is the credential'),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Accept an invite: set the email and password, activate the employee and sign in',
        body: z.object({ token: z.string().min(1).max(200), email: NewEmail, password: Password }).strict(),
        response: { 200: SignedInResponse },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      return signedIn(reply, await id.auth.acceptInvite({ ...req.body, ...clientMeta(req) }))
    },
  )

  app.post(
    '/auth/password/forgot',
    {
      config: {
        access: access.public('Always answers 202 so account existence is not revealed'),
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Request a password-reset link (always 202)',
        body: z.object({ email: Email }).strict(),
        response: { 202: z.object({ accepted: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      await id.auth.forgotPassword({ email: req.body.email, ...clientMeta(req) }).catch((e: unknown) => {
        req.log.warn({ err: e }, 'forgot-password failed')
      })
      return reply.status(202).send({ accepted: true })
    },
  )

  app.post(
    '/auth/password/reset',
    {
      config: {
        access: access.public('Consumes a one-time reset token; the token is the credential'),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Set a new password with a reset token; revokes every session of the account',
        body: z.object({ token: z.string().min(1).max(200), password: Password }).strict(),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const id = await identityOf()
      await id.auth.resetPassword({ ...req.body, ...clientMeta(req) })
      return { ok: true as const }
    },
  )

  app.post(
    '/auth/password/change',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['auth'],
        summary: 'Change the password; every other session is revoked',
        body: z.object({ currentPassword: Password, newPassword: Password }).strict(),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const ctx = sessionContext(req)
      const id = await identityOf()
      await id.auth.changePassword(
        {
          userId: ctx.userId,
          employeeId: ctx.employee.id,
          name: ctx.employee.displayName,
          sessionId: ctx.session.id,
        },
        req.body,
        clientMeta(req),
      )
      return { ok: true as const }
    },
  )

  app.get(
    '/me',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['auth'],
        summary: 'The signed-in person: roles, effective permissions and limits, preferences, view-as state',
        response: { 200: MeResponse },
      },
    },
    async (req, reply) => {
      noStore(reply)
      return buildMe(await identityOf(), sessionContext(req))
    },
  )

  app.put(
    '/me/preferences',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['auth'],
        summary: 'Save preferences (theme)',
        body: z.object({ theme: z.enum(['light', 'dark']) }).strict(),
        response: { 200: z.object({ theme: z.enum(['light', 'dark']).nullable() }) },
      },
    },
    async (req) => {
      const ctx = sessionContext(req)
      const id = await identityOf()
      await id.db
        .insertInto('user_preferences')
        .values({ user_id: ctx.userId, theme: req.body.theme, updated_at: id.clock.now() })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({ theme: req.body.theme, updated_at: id.clock.now() }),
        )
        .execute()
      return { theme: req.body.theme }
    },
  )

  app.post(
    '/me/view-as',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['auth'],
        summary: 'Super Admin only: evaluate the app as another role (null clears)',
        description:
          'Allowed only when the real person holds the locked Super Admin role, even while viewing as a lesser role (so they can always exit). ' +
          'Authority is then that of the viewed role alone, with no per-person exceptions; audit rows keep the real actor and record the viewed role.',
        body: z.object({ roleId: z.string().uuid().nullable() }).strict(),
        response: { 200: MeResponse },
      },
    },
    async (req) => {
      const ctx = sessionContext(req)
      if (!ctx.canViewAs) throw new AppError('VIEW_AS_FORBIDDEN')
      const id = await identityOf()
      const { roleId } = req.body
      if (roleId) {
        const role = await id.db.selectFrom('roles').select('id').where('id', '=', roleId).executeTakeFirst()
        if (!role) throw new AppError('VIEW_AS_ROLE_NOT_FOUND')
      }
      await transaction(id.db, async (tx) => {
        await id.sessions.setViewAs(ctx.session.id, roleId, tx)
        await audit.record(tx, {
          locationId: ctx.locationId,
          action: roleId ? 'user.view-as.set' : 'user.view-as.clear',
          entityType: 'session',
          entityId: ctx.session.id.slice(0, 12),
          before: { roleId: ctx.viewAsRoleId ?? null },
          after: { roleId },
          ctx: auditContextOf(req),
        })
      })
      const next = (await app.authorizer.resolve(req)) as SessionAuthContext
      return buildMe(id, next)
    },
  )
}
