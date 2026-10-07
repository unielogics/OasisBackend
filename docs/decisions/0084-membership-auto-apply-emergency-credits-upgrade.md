# 0084 Memberships: auto-apply, credits under an emergency closure, upgrade candidacy

Status: accepted (2026-10-07). Closes gap 3 (a, b, c) of the b6 list; builds on ADR 0073. Migration `20261006300100_membership_gaps.sql`.

## (a) Auto-apply

* **Switches.** `plan_credit_rules.auto_apply` (new column, default false; `PATCH /membership-plans/rules/:id {autoApply}`, `cli.member`,
  audited; `GET /membership-plans` lists plans, rules and the flag) and the member's own `memberships.auto_apply` (already settable
  with `PATCH /memberships/:id`). **Either one is enough**; both default off, so nothing changes until an owner opts in. The
  global setting `memberships.auto_apply` from ADR 0073 stays unread (superseded by the two flags; it is not exposed anywhere).
* **The defined moment: completing the visit** (cleaning to completed, in the completing transaction, right after the invoice date
  freezes). Redeeming when the service is delivered means a canceled, no-show or still-open visit never consumes a credit, and
  the invoice shows the discount before payment is collected.
* **How.** The same redemption as the explicit command (`POST /appointments/:id/membership-perks/apply`): a **system** `adjust`
  (reason "Membership credit", note ends "auto-applied", discount = the package line, tax falls with it) through
  `PaymentsService.adjust`, exempt from the actor's adjust limit and permission; plus a `redeem` event on the credit ledger. The
  actor on both rows is the person who completed the job (a crew member with only `jobs.status` is enough). Activity line:
  "Membership credit applied automatically · Express wash".
* **Exactly once.** One redeem per appointment is enforced by the service and by the partial unique index; an earlier manual
  apply, an exhausted rule, an inactive member, a service the plan does not cover, a missing invoice or an invoice with no
  balance (paid in advance) are all quiet skips that consume nothing. It runs under a savepoint and never throws a business
  error, so completing a job cannot fail because of it.
* `evaluate()` in `memberships/apply.ts` is now the single set of guards for both paths; the explicit command still throws the
  same errors in the same order.

## (b) Emergency closure and credits

A credit is *held* by a visit when a `redeem` event names the appointment. The closure's "Protect member credits" toggle
(`emergency_closures.credits`, default on) now does something:
* **At the close**, every affected appointment that holds a credit gets a `protect` marker ("Emergency closure · credit
  protected"). `protect` is a marker: it **moves no count** (before this ADR the cycle summary counted it like a restore). The credit
  stays attached to the visit, so a **reschedule** keeps it (still one redeem, the same discount, no second use, including when
  the new date is in a later cycle: the discount rides on the appointment).
* **When such a visit is canceled or marked no-show** (the closure flagged it and the closure protects credits), a `restore` event
  gives the credit back ("Membership credit restored · emergency closure (Express wash)" in the activity log). It is written in the
  member's *current* cycle; if the redeem belonged to an earlier cycle there is nothing to offset and the credit returns as a
  **bonus** in the current one. To allow that, the cycle summary is now `left = granted + max(0, restores - redeems) - max(0, redeems - restores)`
  (before: `used` was floored at 0 and the extra restore vanished). Idempotent per redeem.
* A visit the closure did not flag, or a closure with the toggle off, restores nothing; an ordinary cancel of a held credit also keeps
  it used (a policy question for the owner, not a closure effect).
* Retention counts completed visits only, so a closure produces no missed-visit penalty.
* **Known limit.** A credit the member had *not yet* redeemed is not carried across a renewal when a closure pushes the visit into
  the next cycle (the new cycle grants its own credits; the old unused one expires as before). Carrying it needs the next cycle's
  start, which Squarespace-driven members do not have in advance.

## (c) Upgrade candidacy in the appointment file

`GET /appointments/:id` has a new `membershipUpgrade {candidate, visits60, copy}` next to `membership`. It is set only when the client
has no live membership (pending, active, past_due or paused); `membership` stays null for non-members, so the block's existing contract
does not change. `visits60` is the count of completed appointments in the last 60 days (canceled, no-show, open and older visits do
not count); `candidate` is `visits60 >= 3`; `copy` is the design's sentence with the real number, null when not a candidate. The same
rule as `GET /customers/:id/membership` (`upgradeOf`), batched through `MembershipPort.upgradeCandidates`.

Tests: `test/memberships-gaps/{auto-apply,emergency-credits,upgrade-candidacy}.test.ts` (20, real Postgres, real app).
