# 0073 Memberships: plans, credits, inference and the Operations port

Status: accepted (2026-10-07). Implements backend design 3.8, 4.6 and reviews B11, B12, B43.

Migration `20261006210000_memberships.sql` (`membership_plans`, `plan_credit_rules`, `memberships`, `membership_credit_events`,
and the foreign key `appointments.membership_id -> memberships`). Code in `src/modules/memberships`.

* **Plans** are display data plus credit rules. Essential, Premium, Executive, Exotic with the design's perks (verbatim), badge
  colours and tint, and discount basis points 1000 / 1500 / 2000 / 2500 (Exotic also 2500 on services). Percent perks are never
  applied; `memberships.auto_apply` defaults to false and nothing reads it yet. "Premium Care" is a Premium member whose
  `plan_label` is "Premium Care". `ensurePlans` creates them idempotently (seed, product map, sync, cycle job); the migration does
  not, because the location row does not exist yet.
* **Credit rules** (B12), by `services.tags` (express, premium, executive, handwash): Essential 2 express per cycle; Premium 2
  premium; Executive unlimited express and 2 executive; Exotic unlimited hand washes. `per_cycle = null` is unlimited (shown as
  the infinity sign: `creditsLeft = null`).
* **Credit events** are append-only: a grant per rule per cycle (`qty` = `per_cycle`, null for unlimited), `redeem` when applied.
  Left = grants minus redeems for the cycle that started at `memberships.current_period_start`, over the rules of the member's
  current plan (a tier change starts the new plan's credits without touching history). Unused credits do not carry over.
* **Apply credit** (`POST /appointments/:id/membership-perks/apply`, `cli.member`, Idempotency-Key required): the member must be
  active, the plan must have an unused credit whose tags cover the appointment's service, the invoice must have a balance and the
  appointment must be open. It calls `PaymentsService.adjust` with a **system** source (a one-line hook: `CommandContext.source`)
  for a discount equal to the package line (capped at the adjusted subtotal), reason "Membership credit", a caller whose adjust
  permission and limit are lifted for this command only but who stays the recorded actor. Tax falls with it because adjustments
  are pre-tax. One credit per appointment, enforced by a partial unique index as well.
* **Inference pass** (`syncMemberships`, after a sync that changed orders and in the daily job): the pure inference over membership
  orders of the last 420 days; people are linked by Squarespace customer id, then email, then phone (`sqsp_customer_links`; ambiguity
  links nobody); status is active until the paid period ends plus `SQSP_MEMBERSHIP_GRACE_DAYS` (7), then past_due, then, lagged and
  flagged `lagged_cancellation`, canceled after `SQSP_LAPSE_CANCEL_DAYS` (60) more days; a full refund flags review and never
  cancels; a payment after a cancellation reactivates the same row. Someone who matches no customer raises
  `membership_needs_customer` (`PUT /integrations/squarespace/customer-links/:id` links them and runs the pass). Grace and review
  flags are kept current even when nothing else changes.
* **Manual override**: `PATCH /memberships/:id` (and `POST /memberships` for a member with no subscription data) sets
  `manual_status_at`; the inference leaves the row alone until a **newer paid order** arrives (stronger than the pure rule, which
  only held paused and canceled). A seeded or manual member's cycle is rolled forward by the plan's interval by the daily job.
* **Retention, upgrade, history** are computed from real appointments and invoices: Loyal when completed visits in the last 30 days
  are at least 1 and at least the 30 before, else `Watch · N missed visit(s)` with the design wording. One deviation: a member who
  joined under 30 days ago with no visit yet reads "New member" (the design's rule would print "Down from 0 to 0 visits").
  Upgrade candidate: a non-member with 3 or more completed visits in 60 days (real count in the copy). History: visit count,
  lifetime spend (paid minus refunded over the customer's invoices), mean days between completed visits, most-used package.
  Months active = whole months since `started_at`, at least 1.
* **MembershipPort** (`dbMembershipPort`): an entry only for appointments of an **active** member: plan label, `creditsLeft`
  (null = unlimited), `creditAvailable` (an unused eligible credit covers this appointment and it has no credit yet), plus additive
  display fields (planKey, renewal instant and label in the business timezone, creditsUsed, perks, colours, memberMonths,
  retention). Batched: a board is a handful of queries. Alert 9 now fires from a real eligibility check.
* **Product map** (`sqsp_products`, `GET/PUT /integrations/squarespace/product-map`): Squarespace has no subscription flag or tier on
  an order, so this table (overlaid on the `SQSP_PRODUCT_MAP` JSON) is the only source of "this product is a Premium membership"
  and "this order is one of ours". `GET` also lists the products seen on the last 90 days of orders and whether each is mapped.
