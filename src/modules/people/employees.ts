// Employees: the Settings "Team" list and drawer. Read models redact pay data without team.edit and contact data
// without cli.contact (or team.edit); writes keep the design's validation strings and the escalation / last-Super rules.
import type { Selectable } from 'kysely'
import type { AuditContext } from '../../platform/audit.js'
import * as audit from '../../platform/audit.js'
import * as realtime from '../../platform/realtime.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid, type NewId } from '../../platform/ids.js'
import { maskEmail, maskPhone, normalizePhone } from '../../platform/phone.js'
import { fmtT } from '../../platform/time.js'
import { hasPermission } from '../../http/authorizer.js'
import type { AuthService, IssuedToken } from '../auth/service.js'
import type { SessionService } from '../auth/sessions.js'
import { ADMIN_RESET_TTL_MS, normalizeEmail } from '../auth/service.js'
import { displayName, initials, type SessionAuthContext } from '../auth/context.js'
import { PERMISSIONS, PERMISSION_KEY_SET, SKILLS, SUPER_ONLY_PERMISSIONS } from '../rbac/catalog.js'
import type { EffectiveMap, Override } from '../rbac/engine.js'
import { bumpRbacVersion, compareRoles, employeeOverrides, employeeRoleIds } from '../rbac/repository.js'
import { loadAuthority } from '../rbac/service.js'
import { scheduleViolations, type BusinessHoursPort, type ScheduleDay } from './business-hours.js'
import type { EmployeesTable, EmploymentType, PayType } from './schema.js'
import {
  assertSuperRemains,
  holdsLockedRole,
  lockSuperRole,
  privilegedRoleIds,
  requireSuper,
} from './guards.js'

export const AVATAR_COLORS = [
  '#0E7A63',
  '#2563EB',
  '#7A3B8A',
  '#C2740B',
  '#0D9488',
  '#B45309',
  '#6B7280',
] as const

export const STATUS_LABEL = { active: 'Active', invited: 'Invite sent', inactive: 'Inactive' } as const

export const MSG = {
  required: 'First name and mobile number are required.',
  noRole: 'Assign at least one role.',
  badPhone: 'Enter a valid mobile number.',
} as const

const DEFAULT_SCHEDULE_ON = new Set([1, 2, 3, 4, 5])

export function defaultSchedule(): ScheduleDay[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    on: DEFAULT_SCHEDULE_ON.has(weekday),
    fromMin: 480,
    toMin: 1080,
  }))
}

export interface EmployeeWrite {
  first?: string
  last?: string
  title?: string
  phone?: string
  email?: string | null
  roles?: string[]
  employmentType?: EmploymentType
  payType?: PayType
  rateText?: string
  skills?: string[]
  schedule?: ScheduleDay[]
  overrides?: Record<string, Override>
  avatarColor?: string | null
}

export interface RoleRef {
  id: string
  key: string | null
  name: string
}

export interface ScheduleView {
  weekday: number
  on: boolean
  fromMin: number
  toMin: number
  from: string
  to: string
}

export interface EmployeeView {
  id: string
  first: string
  last: string
  name: string
  fullName: string
  initials: string
  title: string
  phone: string
  phoneE164: string | null
  email: string | null
  status: 'active' | 'invited' | 'inactive'
  statusLabel: string
  employmentType: EmploymentType
  /** Null when the caller lacks team.edit. */
  payType: PayType | null
  rateText: string | null
  skills: string[]
  avatarColor: string | null
  roles: RoleRef[]
  exceptionCount: number
  daysPerWeek: number
  hasLogin: boolean
  version: number
  createdAt: string
  deactivatedAt: string | null
}

export interface EmployeeDetail extends EmployeeView {
  schedule: ScheduleView[]
  overrides: Record<string, Override>
  effectivePermissions: EffectivePermissionRow[]
  allowedCount: number
}

export interface EffectivePermissionRow {
  key: string
  module: string
  label: string
  on: boolean
  src: string
  ov: Override | null
  limit?: number | null
}

export interface WriteResult {
  employee: EmployeeDetail
  warnings: string[]
}

export interface InviteOutcome {
  sent: boolean
  channel: string
  expiresAt: string
  /** The one-time link, only for a Super Admin and only when no channel delivered it (so it is never lost). */
  link?: string
}

type EmployeeRow = Selectable<EmployeesTable>

const fieldErrors = (detail: string, errors: Array<{ path: string; message: string }>): AppError =>
  new AppError('VALIDATION_FAILED', { detail, errors })

const scheduleView = (d: ScheduleDay): ScheduleView => ({ ...d, from: fmtT(d.fromMin), to: fmtT(d.toMin) })

export interface PeopleServiceDeps {
  db: Db
  clock: Clock
  newId: NewId
  auth: AuthService
  sessions: SessionService
  businessHours: BusinessHoursPort
  warn?: (msg: string, data?: Record<string, unknown>) => void
}

export class PeopleService {
  constructor(private readonly d: PeopleServiceDeps) {}

  // --- reads --------------------------------------------------------------------------------------------------

  private async loadMany(db: Executor, where: { ids?: string[] } = {}) {
    let q = db.selectFrom('employees').selectAll().orderBy('created_at').orderBy('id')
    if (where.ids) {
      if (where.ids.length === 0)
        return {
          rows: [] as EmployeeRow[],
          roles: new Map<string, RoleRef[]>(),
          overrideCount: new Map<string, number>(),
          days: new Map<string, number>(),
          logins: new Set<string>(),
        }
      q = q.where('id', 'in', where.ids)
    }
    const rows = await q.execute()
    const ids = rows.map((r) => r.id)
    if (ids.length === 0)
      return {
        rows,
        roles: new Map<string, RoleRef[]>(),
        overrideCount: new Map<string, number>(),
        days: new Map<string, number>(),
        logins: new Set<string>(),
      }
    const [er, ov, sch, users] = await Promise.all([
      db
        .selectFrom('employee_roles as er')
        .innerJoin('roles as r', 'r.id', 'er.role_id')
        .select(['er.employee_id', 'r.id', 'r.key', 'r.name'])
        .where('er.employee_id', 'in', ids)
        .execute(),
      db
        .selectFrom('employee_permission_overrides')
        .select('employee_id')
        .where('employee_id', 'in', ids)
        .execute(),
      db
        .selectFrom('employee_schedules')
        .select('employee_id')
        .where('employee_id', 'in', ids)
        .where('is_on', '=', true)
        .execute(),
      db.selectFrom('users').select('employee_id').where('employee_id', 'in', ids).execute(),
    ])
    const roles = new Map<string, RoleRef[]>()
    for (const r of er) {
      const list = roles.get(r.employee_id) ?? []
      list.push({ id: r.id, key: r.key, name: r.name })
      roles.set(r.employee_id, list)
    }
    for (const list of roles.values()) list.sort(compareRoles)
    const count = (rs: Array<{ employee_id: string }>) => {
      const m = new Map<string, number>()
      for (const r of rs) m.set(r.employee_id, (m.get(r.employee_id) ?? 0) + 1)
      return m
    }
    return {
      rows,
      roles,
      overrideCount: count(ov),
      days: count(sch),
      logins: new Set(users.map((u) => u.employee_id)),
    }
  }

  private visibility(actor: SessionAuthContext): { pay: boolean; contact: boolean } {
    const edit = hasPermission(actor, 'team.edit')
    return { pay: edit, contact: edit || hasPermission(actor, 'cli.contact') }
  }

  private toView(
    r: EmployeeRow,
    loaded: Awaited<ReturnType<PeopleService['loadMany']>>,
    vis: { pay: boolean; contact: boolean },
  ): EmployeeView {
    return {
      id: r.id,
      first: r.first,
      last: r.last,
      name: displayName(r.first, r.last),
      fullName: `${r.first} ${r.last}`.trim(),
      initials: initials(r.first, r.last),
      title: r.title,
      phone: vis.contact ? r.phone : maskPhone(r.phone),
      phoneE164: vis.contact ? r.phone_e164 : null,
      email: r.email === null ? null : vis.contact ? r.email : maskEmail(r.email),
      status: r.status,
      statusLabel: STATUS_LABEL[r.status],
      employmentType: r.employment_type,
      payType: vis.pay ? r.pay_type : null,
      rateText: vis.pay ? r.rate_text : null,
      skills: r.skills,
      avatarColor: r.avatar_color,
      roles: loaded.roles.get(r.id) ?? [],
      exceptionCount: loaded.overrideCount.get(r.id) ?? 0,
      daysPerWeek: loaded.days.get(r.id) ?? 0,
      hasLogin: loaded.logins.has(r.id),
      version: r.version,
      createdAt: r.created_at.toISOString(),
      deactivatedAt: r.deactivated_at ? new Date(r.deactivated_at).toISOString() : null,
    }
  }

  /**
   * The Settings list. `q` matches first, last, full name, phone, title and role names (never email); phone matching is
   * skipped for callers who cannot see phones, so search is not an oracle for hidden numbers.
   */
  async list(actor: SessionAuthContext, f: { q?: string; role?: string }): Promise<EmployeeView[]> {
    const loaded = await this.loadMany(this.d.db)
    const vis = this.visibility(actor)
    let roleId: string | null = null
    if (f.role) {
      const [ref] = await this.resolveRoles(this.d.db, [f.role], { strict: false })
      if (!ref) return []
      roleId = ref.id
    }
    const q = f.q?.trim().toLowerCase() ?? ''
    const qDigits = q.replace(/[\s().+-]/g, '')
    const out: EmployeeView[] = []
    for (const r of loaded.rows) {
      const roles = loaded.roles.get(r.id) ?? []
      if (roleId && !roles.some((x) => x.id === roleId)) continue
      if (q) {
        const text = [r.first, r.last, `${r.first} ${r.last}`, r.title, ...roles.map((x) => x.name)].map(
          (s) => s.toLowerCase(),
        )
        let hit = text.some((s) => s.includes(q))
        if (!hit && vis.contact) {
          hit =
            r.phone.toLowerCase().includes(q) ||
            (/^\d+$/.test(qDigits) && r.phone.replace(/\D/g, '').includes(qDigits))
        }
        if (!hit) continue
      }
      out.push(this.toView(r, loaded, vis))
    }
    return out
  }

  async get(actor: SessionAuthContext, id: string): Promise<EmployeeDetail> {
    return this.detail(this.d.db, actor, id)
  }

  private async detail(db: Executor, actor: SessionAuthContext, id: string): Promise<EmployeeDetail> {
    const loaded = await this.loadMany(db, { ids: [id] })
    const row = loaded.rows[0]
    if (!row) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
    const [sch, overrides, authority] = await Promise.all([
      db
        .selectFrom('employee_schedules')
        .select(['weekday', 'is_on', 'from_min', 'to_min'])
        .where('employee_id', '=', id)
        .orderBy('weekday')
        .execute(),
      employeeOverrides(db, id),
      loadAuthority(db, id),
    ])
    const schedule = (
      sch.length === 7
        ? sch.map((s) => ({ weekday: s.weekday, on: s.is_on, fromMin: s.from_min, toMin: s.to_min }))
        : defaultSchedule().map((d) => ({ ...d, on: false }))
    ).map(scheduleView)
    const rows = effectiveRows(authority.effective)
    return {
      ...this.toView(row, loaded, this.visibility(actor)),
      schedule,
      overrides,
      effectivePermissions: rows,
      allowedCount: rows.filter((r) => r.on).length,
    }
  }

  async effectivePermissions(
    id: string,
  ): Promise<{ items: EffectivePermissionRow[]; allowedCount: number; total: number }> {
    const exists = await this.d.db
      .selectFrom('employees')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst()
    if (!exists) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
    const authority = await loadAuthority(this.d.db, id)
    const items = effectiveRows(authority.effective)
    return { items, allowedCount: items.filter((i) => i.on).length, total: PERMISSIONS.length }
  }

  // --- validation helpers ---------------------------------------------------------------------------------------

  /** Accepts role ids (uuid) or built-in keys. Unknown references are a validation error unless strict is false. */
  private async resolveRoles(
    db: Executor,
    refs: string[],
    o: { strict: boolean } = { strict: true },
  ): Promise<RoleRef[]> {
    const uniq = [...new Set(refs.map((r) => r.trim()).filter(Boolean))]
    const ids = uniq.filter(isUuid)
    const keys = uniq.filter((r) => !isUuid(r))
    const rows = await db
      .selectFrom('roles')
      .select(['id', 'key', 'name'])
      .where((eb) =>
        eb.or([
          ids.length ? eb('id', 'in', ids) : eb.val(false),
          keys.length ? eb('key', 'in', keys) : eb.val(false),
        ]),
      )
      .execute()
    const found = new Set(rows.flatMap((r) => [r.id, r.key ?? '']))
    const missing = uniq.filter((r) => !found.has(r))
    if (missing.length && o.strict)
      throw fieldErrors(
        'Unknown role.',
        missing.map((m) => ({ path: 'body.roles', message: `Unknown role "${m}"` })),
      )
    return rows.sort(compareRoles)
  }

  private validateProfile(
    input: EmployeeWrite,
    current?: EmployeeRow,
  ): { phoneE164: string | null | undefined } {
    const errors: Array<{ path: string; message: string }> = []
    const first = input.first !== undefined ? input.first.trim() : (current?.first ?? '')
    const phone = input.phone !== undefined ? input.phone.trim() : (current?.phone ?? '')
    if (!first) errors.push({ path: 'body.first', message: MSG.required })
    if (!phone) errors.push({ path: 'body.phone', message: MSG.required })
    if (errors.length) throw fieldErrors(MSG.required, errors)

    let phoneE164: string | null | undefined
    if (input.phone !== undefined && phone !== (current?.phone ?? null)) {
      phoneE164 = normalizePhone(phone)
      if (!phoneE164) throw fieldErrors(MSG.badPhone, [{ path: 'body.phone', message: MSG.badPhone }])
    }
    if (input.skills) {
      const bad = input.skills.filter((s) => !(SKILLS as readonly string[]).includes(s))
      if (bad.length)
        throw fieldErrors(
          'Unknown skill.',
          bad.map((s) => ({ path: 'body.skills', message: `Unknown skill "${s}"` })),
        )
    }
    if (input.overrides) {
      const bad = Object.keys(input.overrides).filter((k) => !PERMISSION_KEY_SET.has(k))
      if (bad.length)
        throw fieldErrors(
          'Unknown permission.',
          bad.map((k) => ({ path: 'body.overrides', message: `Unknown permission "${k}"` })),
        )
    }
    if (input.schedule) {
      const errs: Array<{ path: string; message: string }> = []
      const seen = new Set<number>()
      input.schedule.forEach((s, i) => {
        if (seen.has(s.weekday)) errs.push({ path: `body.schedule[${i}]`, message: 'Duplicate weekday' })
        seen.add(s.weekday)
        if (s.on && !(s.fromMin >= 0 && s.toMin <= 1440 && s.fromMin < s.toMin))
          errs.push({ path: `body.schedule[${i}]`, message: 'Start must be before end' })
      })
      if (errs.length) throw fieldErrors(errs[0]!.message, errs)
    }
    return { phoneE164 }
  }

  /**
   * Validates a schedule the caller supplied against the business hours (422 per day outside them). With no hours
   * configured it passes with a warning instead.
   */
  private async checkSchedule(locationId: string, schedule: ScheduleDay[]): Promise<string[]> {
    const hours = await this.d.businessHours.get(locationId)
    if (!hours) {
      if (!schedule.some((s) => s.on)) return []
      const w =
        'Business hours are not configured, so this schedule was saved without being checked against them.'
      this.d.warn?.(w)
      return [w]
    }
    const errors: Array<{ path: string; message: string }> = []
    schedule.forEach((day, i) => {
      for (const message of scheduleViolations([day], hours))
        errors.push({ path: `body.schedule[${i}]`, message })
    })
    if (errors.length) throw fieldErrors(errors[0]!.message, errors)
    return []
  }

  /** The design's default week (Mon-Fri 8-6) trimmed to the business hours, so creating with defaults never fails on them. */
  private async defaultScheduleFor(locationId: string): Promise<ScheduleDay[]> {
    const hours = await this.d.businessHours.get(locationId)
    const base = defaultSchedule()
    if (!hours) return base
    return base.map((d) => {
      const h = hours.find((x) => x.weekday === d.weekday)
      if (!d.on) return d
      if (!h?.open) return { ...d, on: false }
      const fromMin = Math.max(d.fromMin, h.fromMin)
      const toMin = Math.min(d.toMin, h.toMin)
      return fromMin < toMin ? { ...d, fromMin, toMin } : { ...d, on: false }
    })
  }

  private async assertEmailFree(db: Executor, email: string, exceptEmployeeId?: string): Promise<void> {
    const emp = await db
      .selectFrom('employees')
      .select('id')
      .where('email', '=', email)
      .$if(!!exceptEmployeeId, (q) => q.where('id', '!=', exceptEmployeeId!))
      .executeTakeFirst()
    const usr = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .$if(!!exceptEmployeeId, (q) => q.where('employee_id', '!=', exceptEmployeeId!))
      .executeTakeFirst()
    if (emp || usr)
      throw new AppError('EMAIL_TAKEN', {
        errors: [{ path: 'body.email', message: 'That email address is already in use' }],
      })
  }

  /** Access guards for a change of someone's roles or exceptions. Throws FORBIDDEN / SUPER_ONLY / SELF_DENY_ROLES. */
  private async guardAccessChange(
    db: Executor,
    actor: SessionAuthContext,
    target: { id: string | null; currentRoleIds: string[]; currentOverrides: Record<string, Override> },
    next: { roleIds: string[]; overrides: Record<string, Override> },
  ): Promise<void> {
    if (!hasPermission(actor, 'team.roles'))
      throw new AppError('FORBIDDEN', { meta: { required: ['team.roles'], mode: 'all' } })
    const added = next.roleIds.filter((r) => !target.currentRoleIds.includes(r))
    // Touching a Super Admin's access, assigning Super, or assigning a role that carries a Super-only permission.
    if (target.id && (await holdsLockedRole(db, target.id))) requireSuper(actor)
    if ((await privilegedRoleIds(db, [...added])).size > 0) requireSuper(actor)
    for (const [key, effect] of Object.entries(next.overrides)) {
      if (effect === 'allow' && SUPER_ONLY_PERMISSIONS.has(key) && target.currentOverrides[key] !== 'allow')
        requireSuper(actor)
    }
    if (target.id && target.id === actor.employee.id && next.overrides['team.roles'] === 'deny')
      throw new AppError('SELF_DENY_ROLES')
  }

  // --- create ---------------------------------------------------------------------------------------------------

  async create(
    actor: SessionAuthContext,
    input: EmployeeWrite,
    ac: AuditContext,
  ): Promise<WriteResult & { invite: InviteOutcome }> {
    const { phoneE164 } = this.validateProfile(input)
    if (input.roles && input.roles.length === 0)
      throw fieldErrors(MSG.noRole, [{ path: 'body.roles', message: MSG.noRole }])
    const email = input.email ? normalizeEmail(input.email) : null
    const schedule = input.schedule
      ? normalizeSchedule(input.schedule)
      : await this.defaultScheduleFor(actor.locationId)
    const warnings = input.schedule ? await this.checkSchedule(actor.locationId, input.schedule) : []

    const issued = await transaction(this.d.db, async (tx) => {
      const roles = input.roles
        ? await this.resolveRoles(tx, input.roles)
        : await this.resolveRoles(tx, ['crew'], { strict: false })
      if (roles.length === 0) throw fieldErrors(MSG.noRole, [{ path: 'body.roles', message: MSG.noRole }])
      const overrides = input.overrides ?? {}
      const crewOnly = roles.length === 1 && roles[0]!.key === 'crew'
      if (Object.keys(overrides).length > 0 || !crewOnly) {
        await this.guardAccessChange(
          tx,
          actor,
          { id: null, currentRoleIds: [], currentOverrides: {} },
          { roleIds: roles.map((r) => r.id), overrides },
        )
      }
      if (email) await this.assertEmailFree(tx, email)

      const id = this.d.newId()
      const count = await tx
        .selectFrom('employees')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
      const now = this.d.clock.now()
      await tx
        .insertInto('employees')
        .values({
          id,
          first: input.first!.trim(),
          last: (input.last ?? '').trim(),
          title: (input.title ?? '').trim(),
          phone: input.phone!.trim(),
          phone_e164: phoneE164 ?? null,
          email,
          status: 'invited',
          employment_type: input.employmentType ?? 'full_time',
          pay_type: input.payType ?? 'hourly',
          rate_text: (input.rateText ?? '').trim(),
          skills: input.skills ?? [],
          avatar_color:
            input.avatarColor === undefined
              ? AVATAR_COLORS[Number(count.n) % AVATAR_COLORS.length]!
              : input.avatarColor,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await tx
        .insertInto('employee_locations')
        .values({ employee_id: id, location_id: actor.locationId })
        .execute()
      await tx
        .insertInto('employee_roles')
        .values(roles.map((r) => ({ employee_id: id, role_id: r.id })))
        .execute()
      const ovRows = Object.entries(overrides).map(([permission_key, effect]) => ({
        employee_id: id,
        permission_key,
        effect,
      }))
      if (ovRows.length) await tx.insertInto('employee_permission_overrides').values(ovRows).execute()
      await this.writeSchedule(tx, id, schedule)
      const inv = await this.d.auth.issueInvite(tx, id, actor.userId)
      const version = await bumpRbacVersion(tx)
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'employee.create',
        entityType: 'employee',
        entityId: id,
        after: {
          first: input.first!.trim(),
          last: input.last ?? '',
          roles: roles.map((r) => r.name),
          overrides,
          rbacVersion: version,
        },
        ctx: ac,
      })
      return { id, inv, first: input.first!.trim(), phone: phoneE164 ?? input.phone!.trim(), email }
    })

    const delivery = await this.d.auth.deliver(
      'invite',
      { employeeId: issued.id, first: issued.first, phone: issued.phone, email: issued.email },
      issued.inv,
    )
    const employee = await this.detail(this.d.db, actor, issued.id)
    return { employee, warnings, invite: this.inviteOutcome(actor, issued.inv, delivery) }
  }

  private inviteOutcome(
    actor: SessionAuthContext,
    issued: IssuedToken,
    delivery: { delivered: boolean; channel: string },
  ): InviteOutcome {
    return {
      sent: delivery.delivered,
      channel: delivery.channel,
      expiresAt: issued.expiresAt.toISOString(),
      ...(!delivery.delivered && actor.isSuper ? { link: this.d.auth.linkFor('invite', issued.token) } : {}),
    }
  }

  private async writeSchedule(tx: Tx, employeeId: string, schedule: ScheduleDay[]): Promise<void> {
    await tx.deleteFrom('employee_schedules').where('employee_id', '=', employeeId).execute()
    await tx
      .insertInto('employee_schedules')
      .values(
        schedule.map((s) => ({
          employee_id: employeeId,
          weekday: s.weekday,
          is_on: s.on,
          from_min: s.fromMin,
          to_min: s.toMin,
        })),
      )
      .execute()
  }

  // --- update ---------------------------------------------------------------------------------------------------

  async update(
    actor: SessionAuthContext,
    id: string,
    input: EmployeeWrite,
    version: number,
    ac: AuditContext,
  ): Promise<WriteResult> {
    const current0 = await this.d.db
      .selectFrom('employees')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!current0) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
    const { phoneE164 } = this.validateProfile(input, current0)
    if (input.roles && input.roles.length === 0)
      throw fieldErrors(MSG.noRole, [{ path: 'body.roles', message: MSG.noRole }])
    const email = input.email === undefined ? undefined : input.email ? normalizeEmail(input.email) : null
    const schedule = input.schedule ? normalizeSchedule(input.schedule) : undefined
    const warnings = input.schedule ? await this.checkSchedule(actor.locationId, input.schedule) : []

    await transaction(this.d.db, async (tx) => {
      const cur = await tx
        .selectFrom('employees')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!cur) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
      if (cur.version !== version)
        throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: cur.version } })

      const currentRoleIds = await employeeRoleIds(tx, id)
      const currentOverrides = await employeeOverrides(tx, id)
      const nextRoles = input.roles ? await this.resolveRoles(tx, input.roles) : null
      const nextRoleIds = nextRoles ? nextRoles.map((r) => r.id) : currentRoleIds
      const nextOverrides = input.overrides ?? currentOverrides
      const rolesChanged = !!nextRoles && !sameSet(nextRoleIds, currentRoleIds)
      const overridesChanged = !!input.overrides && !sameMap(nextOverrides, currentOverrides)
      const accessChanged = rolesChanged || overridesChanged
      const before = {
        first: cur.first,
        last: cur.last,
        title: cur.title,
        phone: cur.phone,
        email: cur.email,
        roles: currentRoleIds,
        overrides: currentOverrides,
      }

      const wasSuper = accessChanged && (await holdsLockedRole(tx, id))
      if (accessChanged) {
        if (wasSuper) await lockSuperRole(tx)
        await this.guardAccessChange(
          tx,
          actor,
          { id, currentRoleIds, currentOverrides },
          { roleIds: nextRoleIds, overrides: nextOverrides },
        )
      }

      if (email !== undefined && email !== cur.email) {
        if (email) await this.assertEmailFree(tx, email, id)
        else if (await tx.selectFrom('users').select('id').where('employee_id', '=', id).executeTakeFirst())
          throw fieldErrors('An employee with a login needs an email address.', [
            { path: 'body.email', message: 'An employee with a login needs an email address.' },
          ])
      }

      const now = this.d.clock.now()
      await tx
        .updateTable('employees')
        .set({
          ...(input.first !== undefined ? { first: input.first.trim() } : {}),
          ...(input.last !== undefined ? { last: input.last.trim() } : {}),
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.phone !== undefined ? { phone: input.phone.trim() } : {}),
          ...(phoneE164 !== undefined ? { phone_e164: phoneE164 } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(input.employmentType ? { employment_type: input.employmentType } : {}),
          ...(input.payType ? { pay_type: input.payType } : {}),
          ...(input.rateText !== undefined ? { rate_text: input.rateText.trim() } : {}),
          ...(input.skills ? { skills: input.skills } : {}),
          ...(input.avatarColor !== undefined ? { avatar_color: input.avatarColor } : {}),
          version: cur.version + 1,
          updated_at: now,
        })
        .where('id', '=', id)
        .execute()
      if (email !== undefined && email)
        await tx.updateTable('users').set({ email }).where('employee_id', '=', id).execute()

      if (rolesChanged) {
        await tx.deleteFrom('employee_roles').where('employee_id', '=', id).execute()
        await tx
          .insertInto('employee_roles')
          .values(nextRoleIds.map((role_id) => ({ employee_id: id, role_id })))
          .execute()
      }
      if (overridesChanged) {
        await tx.deleteFrom('employee_permission_overrides').where('employee_id', '=', id).execute()
        const rows = Object.entries(nextOverrides).map(([permission_key, effect]) => ({
          employee_id: id,
          permission_key,
          effect,
        }))
        if (rows.length) await tx.insertInto('employee_permission_overrides').values(rows).execute()
      }
      if (schedule) await this.writeSchedule(tx, id, schedule)
      if (accessChanged) {
        if (wasSuper) await assertSuperRemains(tx)
        const rbacVersion = await bumpRbacVersion(tx)
        await realtime.publish(tx, {
          locationId: actor.locationId,
          channel: 'settings',
          type: 'rbac.changed',
          payload: { reason: 'employee.access', employeeId: id, rbacVersion },
        })
      }
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'employee.update',
        entityType: 'employee',
        entityId: id,
        before,
        after: {
          first: input.first ?? cur.first,
          last: input.last ?? cur.last,
          title: input.title ?? cur.title,
          phone: input.phone ?? cur.phone,
          email: email === undefined ? cur.email : email,
          roles: nextRoleIds,
          overrides: nextOverrides,
        },
        ctx: ac,
      })
    })
    return { employee: await this.detail(this.d.db, actor, id), warnings }
  }

  // --- lifecycle ------------------------------------------------------------------------------------------------

  async deactivate(actor: SessionAuthContext, id: string, ac: AuditContext): Promise<EmployeeDetail> {
    await transaction(this.d.db, async (tx) => {
      const cur = await tx
        .selectFrom('employees')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!cur) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
      if (cur.status === 'inactive') return
      const isSuper = await holdsLockedRole(tx, id)
      if (isSuper) {
        requireSuper(actor)
        await lockSuperRole(tx)
      }
      const now = this.d.clock.now()
      await tx
        .updateTable('employees')
        .set({ status: 'inactive', deactivated_at: now, version: cur.version + 1, updated_at: now })
        .where('id', '=', id)
        .execute()
      const user = await tx.selectFrom('users').select('id').where('employee_id', '=', id).executeTakeFirst()
      if (user) {
        await tx.updateTable('users').set({ disabled_at: now }).where('id', '=', user.id).execute()
        await this.d.sessions.revokeAllForUser(user.id, null, tx)
      }
      await tx
        .updateTable('invites')
        .set({ revoked_at: now })
        .where('employee_id', '=', id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute()
      if (isSuper) await assertSuperRemains(tx)
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'employee.deactivate',
        entityType: 'employee',
        entityId: id,
        before: { status: cur.status },
        after: { status: 'inactive' },
        ctx: ac,
      })
    })
    return this.detail(this.d.db, actor, id)
  }

  /** Back to active when they ever accepted an invite, otherwise back to invited (fixes the design's Q17). */
  async reactivate(actor: SessionAuthContext, id: string, ac: AuditContext): Promise<EmployeeDetail> {
    await transaction(this.d.db, async (tx) => {
      const cur = await tx
        .selectFrom('employees')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!cur) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
      if (cur.status !== 'inactive') return
      if (await holdsLockedRole(tx, id)) requireSuper(actor)
      const user = await tx.selectFrom('users').select('id').where('employee_id', '=', id).executeTakeFirst()
      const status = user ? 'active' : 'invited'
      const now = this.d.clock.now()
      await tx
        .updateTable('employees')
        .set({ status, deactivated_at: null, version: cur.version + 1, updated_at: now })
        .where('id', '=', id)
        .execute()
      if (user) await tx.updateTable('users').set({ disabled_at: null }).where('id', '=', user.id).execute()
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'employee.reactivate',
        entityType: 'employee',
        entityId: id,
        before: { status: 'inactive' },
        after: { status },
        ctx: ac,
      })
    })
    return this.detail(this.d.db, actor, id)
  }

  async resendInvite(actor: SessionAuthContext, id: string, ac: AuditContext): Promise<InviteOutcome> {
    const { issued, emp } = await transaction(this.d.db, async (tx) => {
      const emp = await tx
        .selectFrom('employees')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!emp) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
      if (emp.status !== 'invited') throw new AppError('INVITE_NOT_PENDING')
      const issued = await this.d.auth.issueInvite(tx, id, actor.userId)
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'employee.invite.resend',
        entityType: 'employee',
        entityId: id,
        ctx: ac,
      })
      return { issued, emp }
    })
    const delivery = await this.d.auth.deliver(
      'invite',
      { employeeId: id, first: emp.first, phone: emp.phone_e164 ?? emp.phone, email: emp.email },
      issued,
    )
    return this.inviteOutcome(actor, issued, delivery)
  }

  /** Sends the person a reset link by the notification port. The link is shown to the caller only when it was not delivered and the caller is a Super Admin. */
  async adminPasswordReset(actor: SessionAuthContext, id: string, ac: AuditContext): Promise<InviteOutcome> {
    const { issued, emp } = await transaction(this.d.db, async (tx) => {
      const emp = await tx
        .selectFrom('employees')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!emp) throw new AppError('NOT_FOUND', { detail: 'That employee does not exist' })
      const user = await tx.selectFrom('users').select('id').where('employee_id', '=', id).executeTakeFirst()
      if (!user || emp.status !== 'active') throw new AppError('NO_LOGIN_YET')
      const issued = await this.d.auth.issueReset(tx, user.id, actor.userId, ADMIN_RESET_TTL_MS)
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'employee.password-reset',
        entityType: 'employee',
        entityId: id,
        ctx: ac,
      })
      return { issued, emp }
    })
    const delivery = await this.d.auth.deliver(
      'password_reset',
      { employeeId: id, first: emp.first, phone: emp.phone_e164 ?? emp.phone, email: emp.email },
      issued,
    )
    return {
      sent: delivery.delivered,
      channel: delivery.channel,
      expiresAt: issued.expiresAt.toISOString(),
      ...(!delivery.delivered && actor.isSuper
        ? { link: this.d.auth.linkFor('password_reset', issued.token) }
        : {}),
    }
  }
}

function effectiveRows(m: EffectiveMap): EffectivePermissionRow[] {
  return PERMISSIONS.map((p) => {
    const e = m[p.key]!
    return {
      key: p.key,
      module: p.module,
      label: p.label,
      on: e.on,
      src: e.src,
      ov: e.ov ?? null,
      ...(e.on && e.limit !== undefined ? { limit: e.limit } : {}),
    }
  })
}

function normalizeSchedule(input: ScheduleDay[]): ScheduleDay[] {
  const byDay = new Map(input.map((s) => [s.weekday, s]))
  return defaultSchedule().map((d) => {
    const s = byDay.get(d.weekday)
    return s ? { weekday: d.weekday, on: s.on, fromMin: s.fromMin, toMin: s.toMin } : { ...d, on: false }
  })
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x))
const sameMap = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k])
}
