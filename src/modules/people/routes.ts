// /api/v1/employees* and /api/v1/roles*: the Settings Team and Roles sections.
import type { FastifyReply, FastifyRequest } from 'fastify'
import { access } from '../../http/access.js'
import { auditContextOf } from '../../http/authorizer.js'
import { z } from '../../http/zod.js'
import type { AppInstance } from '../../http/types.js'
import { AppError } from '../../platform/errors.js'
import type { IdentityProvider } from '../auth/routes.js'
import { sessionContext } from '../auth/context.js'
import { LIMIT_CHOICES_DOLLARS, LIMIT_KINDS, type LimitKind } from '../rbac/catalog.js'
import type { EmployeeWrite } from './employees.js'

const Uuid = z.string().uuid()
const IdParams = z.object({ id: Uuid })

const Override = z.enum(['allow', 'deny'])
const RoleRef = z.object({ id: z.string(), key: z.string().nullable(), name: z.string() })
const ScheduleIn = z
  .object({
    weekday: z.number().int().min(0).max(6),
    on: z.boolean(),
    fromMin: z.number().int().min(0).max(1439),
    toMin: z.number().int().min(1).max(1440),
  })
  .strict()

const EmployeeBody = z
  .object({
    first: z.string().max(80).optional(),
    last: z.string().max(80).optional(),
    title: z.string().max(80).optional(),
    phone: z.string().max(40).optional(),
    email: z.union([z.string().trim().email().max(254), z.literal(''), z.null()]).optional(),
    roles: z.array(z.string().min(1).max(64)).max(20).optional(),
    employmentType: z.enum(['full_time', 'part_time', 'contractor']).optional(),
    payType: z.enum(['hourly', 'commission', 'salary']).optional(),
    rateText: z.string().max(40).optional(),
    skills: z.array(z.string().max(40)).max(6).optional(),
    schedule: z.array(ScheduleIn).max(7).optional(),
    overrides: z.record(z.string(), Override).optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
  })
  .strict()

const EmployeeSummary = z.object({
  id: z.string(),
  first: z.string(),
  last: z.string(),
  name: z.string(),
  fullName: z.string(),
  initials: z.string(),
  title: z.string(),
  phone: z.string(),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(['active', 'invited', 'inactive']),
  statusLabel: z.string(),
  employmentType: z.enum(['full_time', 'part_time', 'contractor']),
  payType: z.enum(['hourly', 'commission', 'salary']).nullable(),
  rateText: z.string().nullable(),
  skills: z.array(z.string()),
  avatarColor: z.string().nullable(),
  roles: z.array(RoleRef),
  exceptionCount: z.number().int(),
  daysPerWeek: z.number().int(),
  hasLogin: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  deactivatedAt: z.string().nullable(),
})

const EffectiveRow = z.object({
  key: z.string(),
  module: z.string(),
  label: z.string(),
  on: z.boolean(),
  src: z.string(),
  ov: Override.nullable(),
  limit: z.number().int().nullable().optional(),
})

const EmployeeDetail = EmployeeSummary.extend({
  schedule: z.array(
    z.object({
      weekday: z.number().int(),
      on: z.boolean(),
      fromMin: z.number().int(),
      toMin: z.number().int(),
      from: z.string(),
      to: z.string(),
    }),
  ),
  overrides: z.record(z.string(), Override),
  effectivePermissions: z.array(EffectiveRow),
  allowedCount: z.number().int(),
})

const Outcome = z.object({
  sent: z.boolean(),
  channel: z.string(),
  expiresAt: z.string(),
  link: z.string().optional(),
})

const RoleView = z.object({
  id: z.string(),
  key: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  locked: z.boolean(),
  custom: z.boolean(),
  peopleCount: z.number().int(),
  permissionCount: z.number().int(),
  version: z.number().int(),
})

const LimitRecord = z
  .record(z.string(), z.number().int().nullable())
  .describe('Money limits per kind (refund, adjust, credit) in CENTS; null is No limit')

/** If-Match: "3", W/"3" or 3. */
export function parseIfMatch(req: FastifyRequest): number {
  const raw = req.headers['if-match']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (!v) throw new AppError('PRECONDITION_REQUIRED')
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(v)
  if (!m) throw new AppError('MALFORMED_REQUEST', { detail: 'If-Match must be the version number, e.g. "3"' })
  return Number(m[1])
}

const etag = (reply: FastifyReply, version: number): void => void reply.header('ETag', `"${version}"`)

const toWrite = (b: z.infer<typeof EmployeeBody>): EmployeeWrite => ({
  ...b,
  email: b.email === '' ? null : b.email,
})

export function registerPeopleRoutes(app: AppInstance, identityOf: IdentityProvider): void {
  // --- employees ----------------------------------------------------------------------------------------------

  app.get(
    '/employees',
    {
      config: { access: access.perm('team.view') },
      schema: {
        tags: ['people'],
        summary: 'Employees (the Settings list)',
        description:
          '`q` matches first, last, full name, phone, title and role names, never email. Pay type and rate are null without team.edit; phone and email are masked without cli.contact or team.edit.',
        querystring: z.object({ q: z.string().max(100).optional(), role: z.string().max(64).optional() }),
        response: { 200: z.object({ items: z.array(EmployeeSummary) }) },
      },
    },
    async (req) => {
      const id = await identityOf()
      return { items: await id.people.list(sessionContext(req), req.query) }
    },
  )

  app.get(
    '/employees/:id',
    {
      config: { access: access.perm('team.view') },
      schema: {
        tags: ['people'],
        summary: 'One employee with schedule, exceptions and effective permissions (ETag = version)',
        params: IdParams,
        response: { 200: EmployeeDetail },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      const e = await id.people.get(sessionContext(req), req.params.id)
      etag(reply, e.version)
      return e
    },
  )

  app.post(
    '/employees',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['people'],
        summary: 'Create an employee as invited and send the invite',
        description:
          'Needs team.roles as well when roles other than Crew or any exception is given. Errors: 422 "First name and mobile number are required." / "Assign at least one role.". ' +
          'The invite link is only echoed (`invite.link`) to a Super Admin when no channel delivered it.',
        body: EmployeeBody,
        response: {
          201: z.object({ employee: EmployeeDetail, warnings: z.array(z.string()), invite: Outcome }),
        },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      const r = await id.people.create(sessionContext(req), toWrite(req.body), auditContextOf(req))
      etag(reply, r.employee.version)
      return reply.status(201).header('Location', `/api/v1/employees/${r.employee.id}`).send(r)
    },
  )

  app.put(
    '/employees/:id',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['people'],
        summary: 'Update an employee (If-Match: "<version>")',
        description:
          'Fields are optional; omitted ones are unchanged. Changing roles or exceptions also needs team.roles; touching a Super Admin, assigning Super or a role carrying set.billing/pay.void needs a Super Admin.',
        params: IdParams,
        body: EmployeeBody,
        response: { 200: z.object({ employee: EmployeeDetail, warnings: z.array(z.string()) }) },
      },
    },
    async (req, reply) => {
      const id = await identityOf()
      const r = await id.people.update(
        sessionContext(req),
        req.params.id,
        toWrite(req.body),
        parseIfMatch(req),
        auditContextOf(req),
      )
      etag(reply, r.employee.version)
      return r
    },
  )

  app.post(
    '/employees/:id/deactivate',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['people'],
        summary: 'Deactivate (revokes their sessions; the last active Super Admin cannot be deactivated)',
        params: IdParams,
        response: { 200: EmployeeDetail },
      },
    },
    async (req) =>
      (await identityOf()).people.deactivate(sessionContext(req), req.params.id, auditContextOf(req)),
  )

  app.post(
    '/employees/:id/reactivate',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['people'],
        summary: 'Reactivate; back to invited when they never accepted an invite',
        params: IdParams,
        response: { 200: EmployeeDetail },
      },
    },
    async (req) =>
      (await identityOf()).people.reactivate(sessionContext(req), req.params.id, auditContextOf(req)),
  )

  app.post(
    '/employees/:id/invite/resend',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['people'],
        summary: 'Issue a fresh 7-day invite and send it',
        params: IdParams,
        response: { 200: Outcome },
      },
    },
    async (req) =>
      (await identityOf()).people.resendInvite(sessionContext(req), req.params.id, auditContextOf(req)),
  )

  app.post(
    '/employees/:id/password-reset',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['people'],
        summary: 'Send the employee a password-reset link (SMS first, email fallback)',
        params: IdParams,
        response: { 200: Outcome },
      },
    },
    async (req) =>
      (await identityOf()).people.adminPasswordReset(sessionContext(req), req.params.id, auditContextOf(req)),
  )

  app.get(
    '/employees/:id/effective-permissions',
    {
      config: { access: access.perm('team.view') },
      schema: {
        tags: ['people'],
        summary: 'Per-permission { on, src, ov, limit } for one employee',
        params: IdParams,
        response: {
          200: z.object({
            items: z.array(EffectiveRow),
            allowedCount: z.number().int(),
            total: z.number().int(),
          }),
        },
      },
    },
    async (req) => (await identityOf()).people.effectivePermissions(req.params.id),
  )

  // --- roles ---------------------------------------------------------------------------------------------------

  app.get(
    '/roles',
    {
      config: { access: access.perm('team.view') },
      schema: {
        tags: ['people'],
        summary: 'Roles with the permission catalog, matrix, money limits (cents) and people counts',
        response: {
          200: z.object({
            roles: z.array(RoleView),
            permissions: z.array(
              z.object({
                key: z.string(),
                module: z.string(),
                label: z.string(),
                hasLimit: z.boolean(),
                sort: z.number().int(),
                limitKind: z.string().nullable(),
              }),
            ),
            matrix: z.record(z.string(), z.record(z.string(), z.boolean())),
            limits: z
              .record(z.string(), LimitRecord)
              .describe('roleId to money limits in CENTS (null = No limit; no stored row reads as the 2500 default)'),
            limitChoicesCents: z
              .array(z.number().int().nullable())
              .describe(
                'The limit chips in CENTS (2500 ... 100000, then null for No limit); PUT /roles/{id}/limits/{kind} takes the same chips in DOLLARS',
              ),
            rbacVersion: z.number().int(),
          }),
        },
      },
    },
    async () => (await identityOf()).roles.overview(),
  )

  app.post(
    '/roles',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['people'],
        summary:
          'Add a custom role (copies Crew plus sched.edit, limits 25/25/25; default name "Shift Lead", uniquified)',
        body: z
          .object({ name: z.string().max(60).optional(), description: z.string().max(200).optional() })
          .strict(),
        response: { 201: RoleView },
      },
    },
    async (req, reply) => {
      const role = await (await identityOf()).roles.create(sessionContext(req), req.body, auditContextOf(req))
      return reply.status(201).header('Location', `/api/v1/roles/${role.id}`).send(role)
    },
  )

  app.patch(
    '/roles/:id',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['people'],
        summary: 'Rename or describe a role (not the locked Super Admin role)',
        params: IdParams,
        body: z
          .object({ name: z.string().max(60).optional(), description: z.string().max(200).optional() })
          .strict(),
        response: { 200: RoleView },
      },
    },
    async (req) => {
      const raw = req.headers['if-match']
      const version = raw ? parseIfMatch(req) : null
      return (await identityOf()).roles.update(
        sessionContext(req),
        req.params.id,
        req.body,
        version,
        auditContextOf(req),
      )
    },
  )

  app.put(
    '/roles/:id/permissions/:key',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['people'],
        summary: 'Grant or revoke one permission on a role',
        description:
          'Locked roles answer 409 ROLE_LOCKED ("Super Admin always has every permission"). Granting set.billing or pay.void needs a Super Admin. Publishes `rbac.changed` on the settings channel.',
        params: z.object({ id: Uuid, key: z.string().max(64) }),
        body: z.object({ granted: z.boolean() }).strict(),
        response: { 200: z.object({ roleId: z.string(), key: z.string(), granted: z.boolean() }) },
      },
    },
    async (req) =>
      (await identityOf()).roles.setPermission(
        sessionContext(req),
        req.params.id,
        req.params.key,
        req.body.granted,
        auditContextOf(req),
      ),
  )

  app.put(
    '/roles/:id/limits/:kind',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['people'],
        summary:
          'Set a money limit of a role: 25, 50, 100, 250, 500, 1000 (dollars) or null for No limit; stored in cents',
        description:
          'Super Admin only (403 SUPER_ONLY otherwise, in addition to team.roles). Locked roles answer 409 ROLE_LOCKED.',
        params: z.object({ id: Uuid, kind: z.enum(LIMIT_KINDS) }),
        body: z
          .object({
            value: z
              .number()
              .nullable()
              .refine(
                (v) => (LIMIT_CHOICES_DOLLARS as readonly (number | null)[]).includes(v),
                'Choose 25, 50, 100, 250, 500, 1000 or No limit',
              )
              .describe(
                'DOLLARS, not cents: one of 25, 50, 100, 250, 500, 1000, or null for No limit (25 becomes 2500 cents)',
              ),
          })
          .strict(),
        response: {
          200: z.object({
            roleId: z.string(),
            kind: z.enum(LIMIT_KINDS),
            limitCents: z.number().int().nullable().describe('The stored limit in CENTS; null is No limit'),
          }),
        },
      },
    },
    async (req) =>
      (await identityOf()).roles.setLimit(
        sessionContext(req),
        req.params.id,
        req.params.kind as LimitKind,
        req.body.value,
        auditContextOf(req),
      ),
  )

  app.delete(
    '/roles/:id',
    {
      config: { access: access.perm('team.roles') },
      schema: {
        tags: ['people'],
        summary:
          'Remove a custom role: strips it from people (anyone left with none becomes Crew) and returns the affected count',
        params: IdParams,
        response: {
          200: z.object({
            removed: z.literal(true),
            roleId: z.string(),
            name: z.string(),
            affected: z.number().int(),
            reassignedToCrew: z.number().int(),
          }),
        },
      },
    },
    async (req) => (await identityOf()).roles.remove(sessionContext(req), req.params.id, auditContextOf(req)),
  )
}
