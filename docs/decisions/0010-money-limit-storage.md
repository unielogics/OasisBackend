# 0010 Money limit storage and resolution

Status: accepted (2026-10-06)

Money limits (refund, adjust, credit) per role live in `role_limits (role_id, kind, unlimited, limit_cents)`, one row per kind,
in **integer cents**.

* `unlimited = true` with `limit_cents null` means "No limit"; otherwise `limit_cents >= 0`; a check constraint rejects every
  other combination. **No row means the default of 2500 cents** ($25). A single nullable column could not tell "unlimited" from
  "never set" (review B22, C8), and the design's `Math.max(undefined)` NaN quirk disappears because a missing value is always
  resolved to the default in one place (`roleLimit`).
* The API accepts the design's chip values (25, 50, 100, 250, 500, 1000 dollars, or `null`) and stores `value * 100`; reads
  return cents with the default applied.
* The locked Super Admin role is unlimited whatever rows it has; the engine keys off `is_locked`, never the role name.
* **Resolution** (`effectivePermission`): the limit of a permission is the highest limit among only the roles that *grant*
  that permission, `null` wins, a granting role without a row counts as 2500, and an Allow exception with no granting role gets
  2500 (a Deny removes the permission and its limit). Roles that do not grant the permission never contribute their limits
  (Sofia: support 50 + crew 25 gives refund 50, because only support grants `pay.refund`; Rafael: mgmt 1000 + acct 500 gives
  1000). Limits are per transaction.
* Only a Super Admin may change a limit, enforced in the service and in addition to `team.roles`, so Management cannot raise
  its own ceiling.
* Cached authority is keyed by `(employee, rbac_state.version)`; every change to roles, grants, limits, exceptions or
  assignments bumps the version in the same transaction, so a new limit applies to the next request in every process.
