// Authentication flows: login, logout, invites, forgot/reset, password change, admin-triggered reset.
// Every flow that changes credentials revokes the right sessions and writes an audit row in the same transaction.
import type { Env } from '../../config/env.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import { normalizePhone } from '../../platform/phone.js'
import { displayName } from './context.js'
import {
  accountLink,
  type AccountMessageKind,
  type DeliveryResult,
  type NotificationPort,
} from './notifications.js'
import { passwordProblem, type PasswordHasher } from './password.js'
import type { CreatedSession, SessionService } from './sessions.js'
import type { LoginThrottle } from './throttle.js'
import { hashToken, newToken, TOKEN_SHAPE } from './tokens.js'

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const RESET_TTL_MS = 60 * 60 * 1000
export const ADMIN_RESET_TTL_MS = 24 * 60 * 60 * 1000
/** Forgot-password requests for the same account are coalesced within this window (no SMS/email flooding). */
export const RESET_REQUEST_COOLDOWN_MS = 60 * 1000

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export interface ClientMeta {
  ip?: string | null
  ua?: string | null
  requestId?: string | null
}

export interface SignedInUser {
  id: string
  employeeId: string
  email: string
  name: string
}

export interface LoginResult {
  session: CreatedSession
  user: SignedInUser
}

export interface IssuedToken {
  token: string
  expiresAt: Date
}

export interface AuthServiceDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Pick<Env, 'PUBLIC_DASHBOARD_URL'>
  hasher: PasswordHasher
  sessions: SessionService
  throttle: LoginThrottle
  notifier: NotificationPort
  locationId: string
  warn?: (msg: string, data?: Record<string, unknown>) => void
}

const fieldError = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

export class AuthService {
  constructor(private readonly d: AuthServiceDeps) {}

  private actorCtx(u: { id: string; employeeId: string; name: string }, meta: ClientMeta): AuditContext {
    return {
      actor: { userId: u.id, employeeId: u.employeeId, name: u.name },
      requestId: meta.requestId ?? null,
      ip: meta.ip ?? null,
    }
  }

  async login(
    input: { email: string; password: string; currentToken?: string | null } & ClientMeta,
  ): Promise<LoginResult> {
    const { db, hasher, throttle, clock } = this.d
    const email = normalizeEmail(input.email)
    const ip = input.ip ?? 'unknown'

    const wait = throttle.retryAfterSec(ip, email)
    if (wait > 0) throw new AppError('LOGIN_THROTTLED', { headers: { 'Retry-After': String(wait) } })

    const row = await db
      .selectFrom('users as u')
      .innerJoin('employees as e', 'e.id', 'u.employee_id')
      .select([
        'u.id',
        'u.employee_id',
        'u.email',
        'u.password_hash',
        'u.disabled_at',
        'e.status',
        'e.first',
        'e.last',
      ])
      .where('u.email', '=', email)
      .executeTakeFirst()

    const ok = row
      ? await hasher.verify(input.password, row.password_hash)
      : (await hasher.dummyVerify(input.password), false)
    if (!row || !ok) {
      throttle.failure(ip, email)
      if (row)
        await db
          .updateTable('users')
          .set((eb) => ({ failed_attempts: eb('failed_attempts', '+', 1) }))
          .where('id', '=', row.id)
          .execute()
      throw new AppError('INVALID_CREDENTIALS')
    }
    if (row.disabled_at || row.status !== 'active') throw new AppError('ACCOUNT_DISABLED')

    throttle.success(email)
    const user: SignedInUser = {
      id: row.id,
      employeeId: row.employee_id,
      email: row.email,
      name: displayName(row.first, row.last),
    }
    const rehash = hasher.needsRehash(row.password_hash) ? await hasher.hash(input.password) : null
    const oldId =
      input.currentToken && TOKEN_SHAPE.test(input.currentToken) ? hashToken(input.currentToken) : null

    const session = await transaction(db, async (tx) => {
      if (oldId) await this.d.sessions.revoke(oldId, tx) // rotation: a pre-login session id never survives login
      await tx
        .updateTable('users')
        .set({ failed_attempts: 0, last_login_at: clock.now(), ...(rehash ? { password_hash: rehash } : {}) })
        .where('id', '=', row.id)
        .execute()
      const s = await this.d.sessions.create(row.id, input, tx)
      await audit.record(tx, {
        locationId: this.d.locationId,
        action: 'auth.login',
        entityType: 'user',
        entityId: row.id,
        ctx: this.actorCtx(user, input),
      })
      return s
    })
    await this.d.sessions.purge().catch(() => undefined)
    return { session, user }
  }

  async logout(
    sessionId: string,
    actor: { userId: string; employeeId: string; name: string },
    meta: ClientMeta,
  ): Promise<void> {
    await transaction(this.d.db, async (tx) => {
      await this.d.sessions.revoke(sessionId, tx)
      await audit.record(tx, {
        locationId: this.d.locationId,
        action: 'auth.logout',
        entityType: 'user',
        entityId: actor.userId,
        ctx: this.actorCtx({ id: actor.userId, employeeId: actor.employeeId, name: actor.name }, meta),
      })
    })
  }

  // --- invites -----------------------------------------------------------------------------------------------

  /** Revokes the employee's open invites and creates a fresh one (7 days). The token is returned once; only its hash is kept. */
  async issueInvite(
    tx: Tx,
    employeeId: string,
    createdBy: string | null,
    channel: 'sms' | 'email' | 'link' = 'sms',
  ): Promise<IssuedToken> {
    const now = this.d.clock.now()
    await tx
      .updateTable('invites')
      .set({ revoked_at: now })
      .where('employee_id', '=', employeeId)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute()
    const token = newToken()
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS)
    await tx
      .insertInto('invites')
      .values({
        id: this.d.newId(),
        employee_id: employeeId,
        token_hash: hashToken(token),
        channel,
        expires_at: expiresAt,
        created_by: createdBy,
      })
      .execute()
    return { token, expiresAt }
  }

  async acceptInvite(
    input: { token: string; email: string; password: string } & ClientMeta,
  ): Promise<LoginResult> {
    const email = normalizeEmail(input.email)
    const problem = passwordProblem(input.password, { email })
    if (problem) throw fieldError('body.password', problem)
    if (!TOKEN_SHAPE.test(input.token)) throw new AppError('INVITE_INVALID')
    const passwordHash = await this.d.hasher.hash(input.password)
    const tokenHash = hashToken(input.token)
    const now = this.d.clock.now()

    return transaction(this.d.db, async (tx) => {
      const found = await tx
        .selectFrom('invites')
        .select(['id', 'employee_id'])
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst()
      if (!found) throw new AppError('INVITE_INVALID')
      // serialise with resend / deactivate / a second accept for this person
      const emp = await tx
        .selectFrom('employees')
        .select(['id', 'first', 'last', 'status', 'version'])
        .where('id', '=', found.employee_id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      const invite = await tx
        .selectFrom('invites')
        .select(['id', 'accepted_at', 'revoked_at', 'expires_at'])
        .where('id', '=', found.id)
        .executeTakeFirstOrThrow()
      if (
        invite.accepted_at ||
        invite.revoked_at ||
        invite.expires_at.getTime() <= now.getTime() ||
        emp.status !== 'invited'
      )
        throw new AppError('INVITE_INVALID')

      const clash = await tx
        .selectFrom('users')
        .select('id')
        .where('email', '=', email)
        .unionAll(
          tx.selectFrom('employees').select('id').where('email', '=', email).where('id', '!=', emp.id),
        )
        .executeTakeFirst()
      if (clash)
        throw new AppError('EMAIL_TAKEN', {
          errors: [{ path: 'body.email', message: 'That email address is already in use' }],
        })

      const userId = this.d.newId()
      await tx
        .insertInto('users')
        .values({ id: userId, employee_id: emp.id, email, password_hash: passwordHash, last_login_at: now })
        .execute()
      await tx
        .updateTable('employees')
        .set({ email, status: 'active', version: emp.version + 1, updated_at: now })
        .where('id', '=', emp.id)
        .execute()
      await tx.updateTable('invites').set({ accepted_at: now }).where('id', '=', invite.id).execute()
      await tx
        .updateTable('invites')
        .set({ revoked_at: now })
        .where('employee_id', '=', emp.id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute()
      const user: SignedInUser = {
        id: userId,
        employeeId: emp.id,
        email,
        name: displayName(emp.first, emp.last),
      }
      await audit.record(tx, {
        locationId: this.d.locationId,
        action: 'auth.invite.accepted',
        entityType: 'employee',
        entityId: emp.id,
        ctx: this.actorCtx(user, input),
      })
      const session = await this.d.sessions.create(userId, input, tx)
      return { session, user }
    })
  }

  // --- password reset ------------------------------------------------------------------------------------------

  async issueReset(tx: Tx, userId: string, requestedBy: string | null, ttlMs: number): Promise<IssuedToken> {
    const now = this.d.clock.now()
    await tx
      .updateTable('password_resets')
      .set({ used_at: now })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .execute()
    const token = newToken()
    const expiresAt = new Date(now.getTime() + ttlMs)
    await tx
      .insertInto('password_resets')
      .values({
        id: this.d.newId(),
        user_id: userId,
        token_hash: hashToken(token),
        expires_at: expiresAt,
        requested_by: requestedBy,
      })
      .execute()
    return { token, expiresAt }
  }

  /** Always resolves; whether the email exists is never revealed. */
  async forgotPassword(input: { email: string } & ClientMeta): Promise<void> {
    const email = normalizeEmail(input.email)
    const now = this.d.clock.now()
    const u = await this.d.db
      .selectFrom('users as u')
      .innerJoin('employees as e', 'e.id', 'u.employee_id')
      .select([
        'u.id',
        'u.employee_id',
        'u.email',
        'u.disabled_at',
        'e.status',
        'e.first',
        'e.last',
        'e.phone',
        'e.phone_e164',
      ])
      .where('u.email', '=', email)
      .executeTakeFirst()
    if (!u || u.disabled_at || u.status !== 'active') return
    const recent = await this.d.db
      .selectFrom('password_resets')
      .select('id')
      .where('user_id', '=', u.id)
      .where('created_at', '>', new Date(now.getTime() - RESET_REQUEST_COOLDOWN_MS))
      .executeTakeFirst()
    if (recent) return
    const issued = await transaction(this.d.db, async (tx) => {
      const t = await this.issueReset(tx, u.id, null, RESET_TTL_MS)
      await audit.record(tx, {
        locationId: this.d.locationId,
        action: 'auth.password.forgot',
        entityType: 'user',
        entityId: u.id,
        ctx: this.actorCtx(
          { id: u.id, employeeId: u.employee_id, name: displayName(u.first, u.last) },
          input,
        ),
      })
      return t
    })
    // Not awaited: the SMS or email hop would make a known address answer slower than an unknown one. deliver() never rejects.
    void this.deliver(
      'password_reset',
      { employeeId: u.employee_id, first: u.first, phone: u.phone_e164 ?? u.phone, email: u.email },
      issued,
    )
  }

  async resetPassword(input: { token: string; password: string } & ClientMeta): Promise<void> {
    const problem = passwordProblem(input.password)
    if (problem) throw fieldError('body.password', problem)
    if (!TOKEN_SHAPE.test(input.token)) throw new AppError('RESET_INVALID')
    const passwordHash = await this.d.hasher.hash(input.password)
    const now = this.d.clock.now()
    await transaction(this.d.db, async (tx) => {
      const r = await tx
        .selectFrom('password_resets as r')
        .innerJoin('users as u', 'u.id', 'r.user_id')
        .innerJoin('employees as e', 'e.id', 'u.employee_id')
        .select([
          'r.id',
          'r.user_id',
          'r.used_at',
          'r.expires_at',
          'u.disabled_at',
          'u.employee_id',
          'e.status',
          'e.first',
          'e.last',
        ])
        .where('r.token_hash', '=', hashToken(input.token))
        .forUpdate()
        .executeTakeFirst()
      if (
        !r ||
        r.used_at ||
        r.expires_at.getTime() <= now.getTime() ||
        r.disabled_at ||
        r.status !== 'active'
      )
        throw new AppError('RESET_INVALID')
      await tx
        .updateTable('password_resets')
        .set({ used_at: now })
        .where('user_id', '=', r.user_id)
        .where('used_at', 'is', null)
        .execute()
      await tx
        .updateTable('users')
        .set({ password_hash: passwordHash, password_changed_at: now, failed_attempts: 0 })
        .where('id', '=', r.user_id)
        .execute()
      await this.d.sessions.revokeAllForUser(r.user_id, null, tx)
      await audit.record(tx, {
        locationId: this.d.locationId,
        action: 'auth.password.reset',
        entityType: 'user',
        entityId: r.user_id,
        ctx: this.actorCtx(
          { id: r.user_id, employeeId: r.employee_id, name: displayName(r.first, r.last) },
          input,
        ),
      })
    })
  }

  async changePassword(
    actor: { userId: string; employeeId: string; name: string; sessionId: string },
    input: { currentPassword: string; newPassword: string },
    meta: ClientMeta,
  ): Promise<void> {
    const throttleKey = `user:${actor.userId}`
    const ip = meta.ip ?? 'unknown'
    const wait = this.d.throttle.retryAfterSec(ip, throttleKey)
    if (wait > 0) throw new AppError('LOGIN_THROTTLED', { headers: { 'Retry-After': String(wait) } })
    const u = await this.d.db
      .selectFrom('users')
      .select(['password_hash', 'email'])
      .where('id', '=', actor.userId)
      .executeTakeFirstOrThrow()
    if (!(await this.d.hasher.verify(input.currentPassword, u.password_hash))) {
      this.d.throttle.failure(ip, throttleKey)
      throw new AppError('CURRENT_PASSWORD_INVALID', {
        errors: [{ path: 'body.currentPassword', message: 'Current password is incorrect' }],
      })
    }
    const problem = passwordProblem(input.newPassword, { email: u.email })
    if (problem) throw fieldError('body.newPassword', problem)
    const passwordHash = await this.d.hasher.hash(input.newPassword)
    const now = this.d.clock.now()
    this.d.throttle.success(throttleKey)
    await transaction(this.d.db, async (tx) => {
      await tx
        .updateTable('users')
        .set({ password_hash: passwordHash, password_changed_at: now, failed_attempts: 0 })
        .where('id', '=', actor.userId)
        .execute()
      await tx
        .updateTable('password_resets')
        .set({ used_at: now })
        .where('user_id', '=', actor.userId)
        .where('used_at', 'is', null)
        .execute()
      await this.d.sessions.revokeAllForUser(actor.userId, actor.sessionId, tx)
      await audit.record(tx, {
        locationId: this.d.locationId,
        action: 'auth.password.change',
        entityType: 'user',
        entityId: actor.userId,
        ctx: this.actorCtx({ id: actor.userId, employeeId: actor.employeeId, name: actor.name }, meta),
      })
    })
  }

  // --- delivery ------------------------------------------------------------------------------------------------

  /** Hands a one-time link to the notification port (SMS first, email fallback). Call after the transaction committed. */
  async deliver(
    kind: AccountMessageKind,
    to: { employeeId: string; first: string; phone: string | null; email: string | null },
    issued: IssuedToken,
  ): Promise<DeliveryResult> {
    try {
      return await this.d.notifier.deliver({
        kind,
        employeeId: to.employeeId,
        firstName: to.first,
        phone: to.phone ? (normalizePhone(to.phone) ?? to.phone) : null,
        email: to.email,
        link: accountLink(this.d.env.PUBLIC_DASHBOARD_URL, kind, issued.token),
        expiresAt: issued.expiresAt,
      })
    } catch (e) {
      this.d.warn?.('account message delivery failed', {
        kind,
        error: e instanceof Error ? e.message : String(e),
      })
      return { delivered: false, channel: 'none' }
    }
  }

  linkFor(kind: AccountMessageKind, token: string): string {
    return accountLink(this.d.env.PUBLIC_DASHBOARD_URL, kind, token)
  }

  async userIdOfEmployee(db: Executor, employeeId: string): Promise<string | null> {
    const r = await db
      .selectFrom('users')
      .select('id')
      .where('employee_id', '=', employeeId)
      .executeTakeFirst()
    return r?.id ?? null
  }
}
