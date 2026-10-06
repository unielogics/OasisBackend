// Who is acting, and what limits apply. Built from the request's AuthContext (the session authorizer's effective
// authority): the limit of a kind is the highest among the roles that GRANT the permission (null = unlimited, no row =
// 2500 cents), ledger actor_roles are the names of those roles, and under view-as the REAL person is the actor while the
// permissions and limits come from the viewed role (src/modules/rbac, ADR 0009).
import type { AuthContext } from '../../http/authorizer.js'
import { isSessionContext } from '../auth/context.js'
import { DEFAULT_LIMIT_CENTS, type LimitKind } from '../rbac/catalog.js'
import { roleLimit } from '../rbac/engine.js'

export interface PayActor {
  userId: string
  employeeId: string | null
  name: string
  viewAsRoleId: string | null
  has(perm: string): boolean
  /** Cents; null = unlimited; 0 when the actor lacks the permission of that kind. */
  limit(kind: LimitKind): number | null
  /** Names of the roles that grant the permission, joined with " + " ("Management + Accounting"). */
  rolesFor(perm: string): string
  /** The role(s) that provide the limit of a kind, for "Over your $50 limit as Customer Support". */
  limitRole(kind: LimitKind): string
}

const join = (names: readonly string[]): string => names.join(' + ')

export function actorFromAuth(ctx: AuthContext): PayActor {
  const has = (perm: string): boolean => ctx.permissions.has('*') || ctx.permissions.has(perm)
  const session = isSessionContext(ctx) ? ctx : null
  const permOf = (kind: LimitKind): string => `pay.${kind}`
  const actor: PayActor = {
    userId: ctx.realUserId ?? ctx.userId,
    employeeId: ctx.employeeId,
    name: ctx.actorName ?? 'Unknown',
    viewAsRoleId: ctx.viewAsRoleId ?? null,
    has,
    limit(kind) {
      if (!has(permOf(kind))) return 0
      const v = ctx.limits?.[kind]
      if (v !== undefined) return v
      return ctx.permissions.has('*') ? null : DEFAULT_LIMIT_CENTS
    },
    rolesFor(perm) {
      const via = session?.authority.effective[perm]?.via
      if (via && via.length) return join(via)
      if (session?.authority.overrides[perm] === 'allow') return 'Exception'
      return join(ctx.roles ?? [])
    },
    limitRole(kind) {
      const perm = permOf(kind)
      const limit = actor.limit(kind)
      if (!session) return join(ctx.roles ?? [])
      const granting = session.authority.roles.filter((r) => r.locked || r.perms.has(perm))
      const best = granting.filter((r) => roleLimit(r, kind) === limit).map((r) => r.name)
      return best.length ? join(best) : actor.rolesFor(perm)
    },
  }
  return actor
}
