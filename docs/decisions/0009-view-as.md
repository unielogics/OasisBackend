# 0009 View-as semantics

Status: accepted (2026-10-06)

The designs' "Preview as {role}" survives only as a Super Admin "view as". Decisions:

* **Who**: allowed only when the *real* person holds the locked Super Admin role (`roles.is_locked`, not a name). `canViewAs`
  is computed from the real roles on every request, separately from the effective authority, so a Super viewing a role that has
  no permissions can always exit, and a person who stops being Super loses view-as immediately even if the session still
  carries a role.
* **What it evaluates**: the viewed role *only*. Per-person exceptions are ignored in both directions (a Deny on the real person
  does not carry over, an Allow does not either), matching the design's role-based preview. Reads and writes both run as that
  role, because the Payments design needs writes to demonstrate the approval flow. Authority can never exceed Super since it
  is a single role's permissions.
* **Escalation guards use the viewed role**: `isSuper` is false when viewing any role but the locked one, so changing limits,
  assigning Super and granting Super-only permissions are closed while viewing Management.
* **Where it lives**: `sessions.view_as_role_id` (server-side, per session, ends with the session). Review B21 suggested a
  short-lived signed cookie; a column keeps one source of truth, makes revocation and deletion of the role (`on delete set
  null`) automatic, and cannot be forged.
* **Audit**: every audit row records the real user as the actor and the viewed role in `view_as_role_id`; `employeeId` in the
  request context is the real person, which keeps requester/approver separation (self-approval) tamper-proof under view-as.
  Review C7 notes the consequence: a Super viewing as Management (limit 1000) cannot approve a refund their own view-as
  requested beyond that limit; that is intended.
* **API**: `POST /me/view-as {roleId|null}` and the `viewAs` block of `GET /me` (with `options`, every role and its limits, for
  the menu).
