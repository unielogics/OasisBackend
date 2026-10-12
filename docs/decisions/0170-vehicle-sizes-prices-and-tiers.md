# 0170 Prices by vehicle size, a computed member price, and editable membership tiers
Status: accepted (2026-10-12, the owner's plan "Square payments + prices by vehicle size + editable membership tiers", decisions 1-9;
built in wave Q1a, the pricing core). Wave Q2 adds the booking paths, Q3 the website, the assistant and Square billing (below).

The owner wants prices **per vehicle size** (compact car, large car, compact SUV, large SUV, truck), every service, tier, inclusion
and member % off editable in Settings without code, a **household** membership priced at a chosen size (a larger car is covered up to
the plan-size price and the difference is charged at the shop), starting at **$40** for a single wash and **$129/month** for Gold.
Before this, a service had one plain price plus a member and a guest price (the guest price a 20% markup), tint was a separate
matrix, the membership plans had four fixed keys with the website selling two of them as Gold and VIP through a fixed mapping, and a
plan's credits covered services by tag. This ADR replaces all of that with one model.

## Decisions

1. **Vehicle sizes are an editable list per location** (`vehicle_classes`, built on the categories pattern): key (slug, never
   changes), label, sort (size order, smallest first), active. Defaults `compact_car`, `large_car`, `compact_suv`, `large_suv`,
   `truck`; at most 12. A size anything uses (a price, a tier price, a membership, a vehicle, a visit) cannot be deleted
   (`CLASS_IN_USE`), only turned off; the last active size stays on.
2. **One regular price per service and size** (`service_class_prices`; an "up to" price makes a range, for tint). A missing cell is
   "not set". This replaces the member and guest prices, the guest markup and the tint matrix (kept, read only, for one release).
3. **The member price is computed, never typed:** price × (1 − the tier's % off), rounded **half up to whole dollars**
   (`memberCents`; 0% leaves the price as it is; never above the price). The % off is per tier (`member_discount_bp`, 0 at
   migration, so nothing anyone pays changes).
4. **Coverage is capped at the plan size:** an inclusion covers min(price at the visit size, price at the plan size); the line is
   charged the regular price and the **size difference stays due with no % off**. Covered lines get no % off either.
5. **Tiers stay in `membership_plans` with slug keys.** `premium` is renamed `gold` and `executive` `vip`; the old key is kept in
   `legacy_key`, through which old Squarespace product names, product rows, the bootstrap map and staff inputs still resolve
   (`planByKey`); the two foreign keys that use the key (personal links, checkouts) follow by their `on update cascade`. A tier gains
   `public` (sold on the website and by the assistant), `vip_booking` (the VIP slot rules, which no longer come from the key),
   `max_vehicles`, `price_version`, `square_plan_id`. The fixed `PUBLIC_TIERS` / `PlanKey` / `TIERS` lists are gone: every schema
   that had the four keys takes a validated slug.
6. **A tier's monthly price is per size and append-only** (`membership_tier_prices`, guard trigger): a save supersedes the current
   price and adds a row at the tier's next `price_version` with `square_state pending`. This table **is** the Square plan-variation
   history (wave Q3b syncs each row to one SUBSCRIPTION_PLAN_VARIATION; no separate table); `memberships.tier_price_id` names the
   price billed, so existing members keep their price until staff press "Move members" (plan decision 8).
7. **Inclusions replace tag rules** (`membership_inclusions` + `membership_inclusion_services`): a label, `per_cycle` N (null =
   unlimited) or `every_visit`, `auto_apply`, and the services covered. The migration made one inclusion per credit rule **with the
   same id** and the services its tags covered then; `plan_credit_rules` stays as history. Credit events gain `inclusion_id`
   (backfilled from `rule_id`), so old events count through the new model.
8. **A membership is priced at a size** (`memberships.plan_class`, **required**: plan override 1, no uncapped legacy coverage;
   production has no members). Until every path names one (wave Q2), an insert without it gets the location's smallest active
   size (trigger). A membership may cover a **household** (`membership_household`, one live household per customer); credits are
   per membership, so they are shared.
9. **Nothing switches on by itself.** The migration copies today's prices and changes no charge; no job is added; the new seed
   `pricing-defaults` is run by hand in production (rollout step 1).

## The model

| Table / column | Holds |
|---|---|
| `vehicle_classes` | the sizes (pk `(location_id, key)`) |
| `service_class_prices` | price per service and size, optional max; fk to the size, on update cascade |
| `vehicles.vehicle_class`, `.vehicle_class_source` | the car's size and who said it (`staff`, `client`, `ai`, `legacy`); backfilled from `vehicle_type` (sedan_coupe → compact_car, suv_crossover → compact_suv, truck_van → truck) |
| `membership_plans` (+ `member_discount_bp`, `public`, `vip_booking`, `max_vehicles`, `price_version`, `square_plan_id`, `legacy_key`) | the tiers |
| `membership_tier_prices` | tier × size × version, append-only, one current row per tier and size |
| `membership_inclusions`, `membership_inclusion_services` | what a tier includes |
| `membership_credit_events` (+ `inclusion_id`, `service_id`, `line_cents`, `covered_cents`, `plan_class`, `visit_class`) | the credit ledger; unique redeem per appointment **and inclusion** |
| `memberships.plan_class`, `.tier_price_id`; `membership_household`; `membership_checkouts.plan_class` | the plan size, the price billed, the household |
| `appointments`, `appointment_addons`, `invoice_items` (+ `list…`, `discount_bp`, `price_basis`); `appointments.vehicle_class(_label)`, `class_confirmed_at`; `invoices.vehicle_class_label` | the price snapshot of a visit, written from wave Q2 (`price_basis legacy` until then) |

The backfill invents nothing: a service with a member price gets today's guest price (its own, else the member price plus the
markup, the old `withMarkup` rule) at the first size; a tint package gets one cell per matrix row of its film (sedan → compact_car,
suv → compact_suv, truck → truck; other vehicle types are skipped); a plan's monthly price becomes its price at the first size;
`catalog.tint_films` is copied from the matrix's films. `essential` and `exotic` become not public, and inactive unless a live
membership uses them.

## The engine (`src/modules/catalog/price-book.ts`)

Pure functions over a loaded book (`loadPriceBook`: the active sizes, every service, the cells, the tint films):

* `classPrice(book, service, size)`: the size's cell (`class`); no size, an unknown or turned-off one: the first active size's cell,
  else the starting price (`unknown_class`); a known size without a cell: the starting price (`estimated`, "confirm the price at the
  shop"); no cell on any active size: `services.price_cents` (`base`).
* `fromPrice` (the starting price: the lowest cell over the active sizes), `memberFromPrice`, `tierFromPrice`, `memberCents`.
* `priceLine(book, line, size, member)` and `quoteVisit(book, visit, member)`: rules 3 and 4 above; a whole visit spends one credit
  per covered line.
* `loadMemberContext(db, location, customer)`: the ACTIVE membership the customer holds **or shares as a live household member**,
  with the tier's % off, VIP flag, plan size and active inclusions with this cycle's credits. Scheduling reaches it through
  `MembershipPort.pricingFor` (ADR 0040); `InMemoryMemberships` has a double.

`services.price_cents` is kept equal to the starting price (`syncBookingPrices`, audited `catalog.price.sync`, run when a size is
turned on or off; a grid save sets it on the rows it changes): it is the base price of a service without size prices and what the
old public catalog and today's booking flows read until wave Q2 prices visits by size.

## The API (api-spec 15.9 and 15.10)

Staff (Settings → Catalog; reads any signed-in user, writes `set.services`, audited, `settings.changed`): sizes CRUD
(`/catalog/vehicle-classes`), the price grid (`PUT /catalog/prices`: rows with their service's version, **all or nothing**, 412
naming the stale row), tiers CRUD with inclusions (`/catalog/tiers`), the tier × size grid (`PUT /catalog/tier-prices`: rows with the
tier's `priceVersion`, all or nothing, append-only), the booking fee (`/catalog/guest-fee`), and `GET /catalog` extended with
`vehicleClasses`, `prices`, `missingPrices`, `tiers`, `guestFee` (Square fields to `set.services` holders only). The old writes
(`PUT /catalog/tint-matrix`, `/catalog/guest-markup`, `/catalog/plans/{key}`) answer **410 `CATALOG_ROUTE_RETIRED`**; the dashboard
package of the same wave switches to the new routes and ships with this release. `PUT /catalog/services/{id}` no longer takes the
member/guest prices or the VIP fields.

The public `GET /public/catalog` (v1) keeps its shape and is built from the new data: starting prices (the member one at the lowest
% off of the public tiers that have a price), the tint packages' cells in the matrix shape, the active public tiers as `plans`; an
item with no price at all (no cell, $0 base) is left out rather than stated as $0. The assistant's shop facts read it unchanged
(their cache fingerprint now covers the new tables; `set_my_vehicle` also records the size its type maps to); the full per-size
facts (`facts-v4`) are wave Q3d's.

## Seeds

`pricing-defaults` (new, idempotent, fills only empty cells, audited "Seed (pricing-defaults)"): Signature Hand Wash (else the
cheapest active wash) at Compact car $40 and Gold at Compact car $129/month; % off 0. `website-catalog` no longer writes any price,
markup or tint matrix (the website's figures were wrong, plan decision 9); it sets the tint films and the Gold/VIP tiers' perks and
warns about inclusions that cover no active service. `ensurePlans` creates the design's tiers (gold and vip carrying their old keys)
only for a location without any tier, so a tier or inclusion staff deleted never comes back.

## What the next waves add

* **Q2 (booking paths):** every booking path takes a size (`createAppointment` `vehicleId`/`vehicleClass`), snapshots the price
  lines (`list_price_cents`, `discount_bp`, `price_basis`, the size label), `PUT /appointments/:id/vehicle-class` (reprice, refused
  when it would overpay), `POST /appointments/quote`, `settleMembershipVisit` (one redeem + adjust per covered line, the covered
  amount capped at the plan size; the per-inclusion unique index is already in place), household routes, `planClass` on joins and
  manual memberships, the invoice DTO coverage fields, the website's "Sedan / Coupe" label bug.
* **Q3:** the website catalog v2 and join flow (size picker, tier prices), the assistant's facts-v4, memberships billed as Square
  subscriptions (each `membership_tier_prices` row a plan variation; "Move members").
* **Later:** a migration drops `vehicles.vehicle_type`, the member/guest/VIP columns, `plan_credit_rules`, `catalog.tint_matrix`
  and `catalog.guest_markup_pct`.
