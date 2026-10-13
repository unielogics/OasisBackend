# 0170 Prices by vehicle size, a computed member price, and editable membership tiers
Status: accepted (2026-10-12, the owner's plan "Square payments + prices by vehicle size + editable membership tiers", decisions 1-9;
built in wave Q1a, the pricing core). Wave Q2 adds the booking paths, Q3 the website, the assistant and Square billing (below; the
public catalog v2 and the assistant's facts by size are wave Q3d).

The owner wants prices **per vehicle size** (compact car, large car, compact SUV, large SUV, truck), every service, tier, inclusion
and member % off editable in Settings without code, a **household** membership priced at a chosen size (a larger car is covered up to
the plan-size price and the difference is charged at the shop), starting at **$40** for a single wash and **$129/month** for Gold.
Before this, a service had one plain price plus a member and a guest price (the guest price a 20% markup), tint was a separate
matrix, the membership plans had four fixed keys with the website selling two of them as Gold and VIP through a fixed mapping, and a
plan's credits covered services by tag. This ADR replaces all of that with one model.

## Decisions

1. **Vehicle sizes are an editable list per location** (`vehicle_classes`, built on the categories pattern): key (slug, never
   changes), label, sort (size order, smallest first), active. Defaults `compact_car`, `large_car`, `compact_suv`, `large_suv`,
   `truck`; at most 12. A size anything uses (a price, a tier price, a membership, a membership checkout, a credit event, a
   vehicle, a visit) cannot be deleted (`CLASS_IN_USE`), only turned off; the last active size stays on. A size turned off still
   prices the memberships already sold at it: coverage reads the plan size's own cell even when that size is off.
2. **One regular price per service and size** (`service_class_prices`; an "up to" price makes a range, for tint). A missing cell is
   "not set". This replaces the member and guest prices, the guest markup and the tint matrix (kept, read only, for one release).
3. **The member price is computed, never typed:** price × (1 − the tier's % off), rounded **half up to whole dollars**
   (`memberCents`; 0% leaves the price as it is; never above the price). The % off is per tier (`member_discount_bp`, 0 at
   migration, so nothing anyone pays changes).
4. **Coverage is capped at the plan size:** an inclusion covers min(price at the visit size, price at the plan size); the line is
   charged the regular price and the **size difference stays due with no % off**. Covered lines get no % off either. The price at
   the plan size is that size's own cell, even after the size is turned off (a member keeps the size they pay for).
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
item with no price at all (no cell, $0 base) is left out rather than stated as $0. Until wave Q3d the assistant's shop facts read
it (their cache fingerprint covers the new tables); since Q3d they read `GET /public/catalog/v2` (facts-v4, below).

## Seeds

`pricing-defaults` (new, idempotent, fills only empty cells, audited "Seed (pricing-defaults)"): Signature Hand Wash (else the
cheapest active wash) at Compact car $40 and Gold at Compact car $129/month; % off 0. `website-catalog` no longer writes any price,
markup or tint matrix (the website's figures were wrong, plan decision 9); it sets the tint films and the Gold/VIP tiers' perks and
warns about inclusions that cover no active service.

Rollout check: the migration already copies an old member or guest price into the Compact car cell of every service that had one,
and `pricing-defaults` never overwrites a set cell. After `pnpm seed -- --profile pricing-defaults`, read its log: the wash line must
name the wash it priced (`wash Signature Hand Wash`). If it says `wash unchanged (… already has a compact_car price of $X, kept …)`,
the $40 was not applied: set it in Settings → Prices. `ensurePlans` creates the design's tiers (gold and vip carrying their old keys)
only for a location without any tier, so a tier or inclusion staff deleted never comes back.

## Wave Q2a: sizes on every booking path, the size change, and membership coverage

Built on branch `ws/q2-booking` (the Q1a columns are written now; one migration, `20261014300000_redeem_per_line.sql`, from the
review below). Code: `scheduling/{visit-pricing,sizing}.ts` (new), `scheduling/{booking,addons,invoicing}.ts`,
`memberships/{apply,plan-class,service,port,emergency,checkouts,household}.ts`,
`public/{bookings,members,memberships}.ts`, `public/links/service.ts`, `assistant/{tools/actions,actions/handler}.ts`,
`standing/series.ts`, `payments/{gateway,detail}.ts`, `customers/{service,http/routes}.ts`. API: api-spec 20.2a, 23.2, 24.3,
26.2-26.4, 28.

1. **The size of a visit**: the size named (a size of the shop that is on; 422 otherwise), else the car's size on file (when that
   size is on), else none (the smallest size's price, `unknown_class`). `createAppointment` takes `vehicleId` (the client's own
   live car; the assistant and the standing series pass it, so a car without a plate is never duplicated), `vehicleClass`,
   `recordClassAs` (the source the size is written on the car with: staff, client, ai; absent: nothing is written) and
   `memberPricing` (false: priced as a guest). A size a client or the assistant says never replaces one staff set.
2. **The snapshot** is the engine's (`quoteVisit` with `MembershipPort.pricingFor`): `price_cents` = the charge (the member price,
   or the regular price on a line an inclusion will cover), `list_price_cents`, `discount_bp`, `price_basis`, the size and its
   label, `membership_id`; the same per add-on and invoice line, the label on the invoice. An add-on added later is priced at the
   visit's size. The item sync keys a line by its whole price (a repriced line is removed and added, so the overpaid guard applies).
3. **Badges**: `needsSizeConfirm` (no size), `needsPriceConfirm` (the size has no price: `estimated`) until `class_confirmed_at`;
   never on a visit booked before sizes. `confirmAtShop` (a line `unknown_class` or `estimated`) adds "We’ll confirm the exact price
   at the shop." to the website's, the link page's and the assistant's confirmations (an optional `{confirm}` in
   `booking_confirmed_web` and `action_booked`, and its Spanish); a service with one price for every size asks nothing.
4. **The size at the shop**: `PUT /appointments/:id/vehicle-class` reprices the package and the live add-ons for the client, stamps
   `class_confirmed_at`, records the size on the car (staff), audits and publishes; 409 `PRICE_CHANGE_OVERPAID` (the gateway's
   `ADDON_REMOVE_OVERPAID` reworded) refuses a change that would overpay. A visit already covered is settled again at the new size
   (item 6): its own redeems count as credits still there. `POST /appointments/quote` previews with the same rules and writes nothing.
5. **The website** (`vehicleClass`, and the label fix): a `vehicle.label` that names a size (a label or key of the shop's, or the
   old "Sedan / Coupe" → compact_car, "SUV / Crossover" → compact_suv, "Truck / Van" → truck, the `vehicle_type` backfill's map) is
   the size and never a car. A guest's size prices the visit and never reaches someone else's record (the `linkOnly` rule); member
   prices only with a member token for the record (an unverified member's number is a guest). The answers add `pricing`.
6. **Settling a visit** (`settleMembershipVisit`, replacing the single-credit `evaluate`/`redeem`): the holder's or a household
   member's ACTIVE membership, locked (appointment → membership → invoice, the order everywhere); `quoteVisit` assigns the inclusions
   (an inclusion covers **every line of the visit it names** while it can: every_visit and unlimited ones always, per_cycle ones while
   credits last; one redeem per covered line, keyed `redeem:<appointment>:<inclusion>`, then `…:<n>` for the inclusion's n-th line or
   replacement); the lines are repriced **from their booked regular price** (a price edit between
   booking and completion never changes a booked visit), covered lines at the regular price, others at the member price; then one
   adjust + one redeem per covered line, each capped at what is left of the subtotal. Explicit apply, completion (auto, under the
   savepoint; a business skip keeps the repricing, any error rolls it back, the completion never fails) and the closure restore (one
   `restore` and one `protect` per redeem) all work per line. **The coverage follows the visit**: a settled visit that changes (the size
   set at the shop, an add-on added or removed: `MembershipPort.resettleCredit`, called before the invoice sync) is settled again with
   its own credits counted as still there; a redeem whose line is gone, is no longer covered, or changed price or plan size is given
   back (a reversing system adjust and a `restore` keyed `restore:<redeem>`, `ledger_event_id` = that adjust, in the redeem's own cycle)
   and each covered line without a redeem gets one (a replacement keeps the cycle it replaces); activity "Membership coverage updated ·
   $40 → $60"; the invoice's `coverage` lists the redeems in force only. A change that would leave a paid visit overpaid (a
   member's paid size difference, then a smaller size) is refused whole before anything is written (the end state is projected with
   the pure `calcInvoice`): 409 `PRICE_CHANGE_OVERPAID` / `ADDON_REMOVE_OVERPAID` / `MEMBERSHIP_NO_BALANCE`, so the settlement's
   adjusts never book a store-credit "Adjustment settlement" on their own (re-verification N1). An apply with nothing new to cover answers
   `MEMBERSHIP_CREDIT_APPLIED`. Arrival does not settle (the design's "optionally at arrival" is left out:
   the completion and the button are enough).
7. **Households**: `membershipOfCustomer` / `activeMembership` / the port's `forAppointments` and `upgradeCandidates` see a live
   household member as the member; `POST /memberships/:id/household {customerId}` and `DELETE …/household/:customerId` (cli.member,
   audited); a client who holds a live membership, or shares another, cannot be added (409 `MEMBERSHIP_HOUSEHOLD_TAKEN`), nor be given
   one of their own while they share one: staff (409 `MEMBERSHIP_HOUSEHOLD_TAKEN`), a personal link's membership start (the same code
   from `openCheckoutIntent`, `LINK_ALREADY_MEMBER` on the page) and the verified website join (`PUBLIC_ALREADY_MEMBER`); the stale-record rule applies as for a manual membership. No cap on household members
   (plan decision 2). `GET /customers/:id/membership` of a household member answers the shared membership with `sharedFrom`.
8. **planClass** everywhere a membership is made: staff create/patch, the website join and the link's `membership/start`
   (`openCheckoutIntent` stores it on the membership and the checkout); absent, the tier's cheapest priced size, else the smallest
   size; a size named without a current tier price is refused (422 `TIER_CLASS_UNPRICED`) on the public paths only (staff may sell
   any size; `tier_price_id` stays null there). The website join keeps today's flow otherwise (a tier without any price still
   joins at the smallest size until wave Q3b).
9. **Display**: invoice items carry `listCents`, `discountBp`, `memberDiscountCents`, `classLabel`; an adjustment that is a
   membership's coverage carries `coverage {serviceName, coveredCents, lineCents, differenceCents, planClassLabel}` (from the redeem
   rows); the invoice summaries (`summariesByAppointment`) and the link page's `InvoiceView` the same. `calcInvoice` /
   `invoice_calc_of` and the integrity check are unchanged.

**Review fixes (2026-10-12).** An independent review of the package found that a visit settled once never followed later changes:
a size confirmed after completion left a Large SUV plan's member owing $21.40 (F1), an included add-on added after completion was
charged the regular price uncovered (F2), and re-applying was refused. Item 6's re-settlement fixes both. One inclusion naming two
add-ons covered only the first (F4): an inclusion now covers every line it names, so the per-inclusion unique index
`uq_credit_redeem_appointment` is dropped (migration `20261014300000_redeem_per_line.sql`; the settlement runs under the appointment
row lock and the unique idempotency key names each redeem). A household member could open a membership of their own through a link
checkout or the verified website join (F3): both refuse now (item 7). The honeypot's answers carry the same size, label and price as
a real answer (F6: `joinTierOf` and `guestPricingOf`, nothing written).

## Wave Q3d: the public catalog v2 and the assistant's facts by size

Built on branch `ws/q3-catalog` (no pricing migration; the W4 leftover's `20261014700000_link_retext.sql` is ADR 0160's). Code:
`public/catalog.ts` (`loadPublicCatalogV2`, `PublicCatalogV2View`), `public/http/routes.ts`, `deploy/nginx/oasis{,-site}.conf.template`;
the assistant's side is ADR 0160 "Wave Q3d". API: api-spec 26.1.

1. **`GET /public/catalog/v2`** (design §9, exactly its shape): `version 2`, the active sizes, the categories, `memberDisplay.discountBp`
   (the lowest % off of the tiers it lists), every listed package and add-on with `prices` **only at the sizes that have one**
   (`cents`, `maxCents`, `memberCents`/`memberMaxCents` = `memberCents()` at that %, half up to whole dollars), `fromCents`/`fromClass`
   (`fromPrice`), `memberFromCents`, a tint package's film and the tiers that include it; the quote-only items; the booking fee and
   `guestFeeCollect` (`counter`/`link`, as a booking answer words it); and the tiers sold online. **A tier without a current price at
   an active size is not listed** (plan decision 3; the Q1a review's deferred F4): it is not in `tiers`, its % off does not count in
   `memberDisplay`, and nothing `includedIn` names it. An item with no cell and a $0 base price is left out, as in v1; an item with a
   base price and no cell has `prices: []` and `fromClass: null`. No ids, versions, price versions, Square ids or states, checkout URLs
   or tags (`test/catalog-settings/catalog-v2.test.ts` walks every key). One addition to §9's shape (review F4): each tier inclusion row
   carries `group`, the inclusion's number in the tier (1, 2, ...; only inclusions covering a listed item), so one inclusion of 4 a
   month over two items (4 in all) reads apart from two inclusions of 4 a month (4 each); the facts group by it and write a shared
   allowance as "Signature Hand Wash or Interior (4 a month in all)".
2. **v1 is unchanged** (the website keeps reading it until wave Q3c switches; v1 `plans` still lists an unpriced public tier with
   `priceCents: null`, as before).
3. **Cache and limits as v1**: `canonicalQuery({})` (a query is 422), `Cache-Control: public, max-age=60`, 60 a minute per address;
   nginx has an exact `location = /api/v1/public/catalog/v2` on both hosts with v1's treatment (GET only, the API zone, the
   `oasis_public` cache under `$scheme$host$uri`, stale on error, no cookie either way): the `^~ /api/v1/public/` prefix would
   neither cache it nor keep it GET only. Ops-kit tests cover both templates (structure, and the live nginx cache on the website's host).
4. **The assistant's facts read v2** (facts-v4): the sizes, every item's prices by size, the tiers sold online with their prices by
   size, % off and inclusions; a tier without a price is not offered by the assistant either (no `{plan:<key>}`, `send_link
   {membership}` refused). `set_my_vehicle` records a size key of the facts (source `ai`, never over a staff size) and
   `propose_booking` passes `vehicleClass` (a staff size on the car wins, also one set between the proposal and the reply number; the
   reply-number handler books it while the size is still on).

## What the next waves add

* **Q2 (booking paths, built in wave Q2a above):** every booking path takes a size (`createAppointment` `vehicleId`/`vehicleClass`), snapshots the price
  lines (`list_price_cents`, `discount_bp`, `price_basis`, the size label), `PUT /appointments/:id/vehicle-class` (reprice, refused
  when it would overpay), `POST /appointments/quote`, `settleMembershipVisit` (one redeem + adjust per covered line, the covered
  amount capped at the plan size; a redeem per covered line, settled again when the visit changes), household routes, `planClass` on joins and
  manual memberships, the invoice DTO coverage fields, the website's "Sedan / Coupe" label bug.
* **Q3:** the website catalog v2 (built in wave Q3d above) and join flow (size picker, tier prices; a tier with no current price is
  not sold online: v2 and the assistant's links leave it out (wave Q3d), which v1 `plans` and `POST /public/memberships/join` do not
  do yet: the join route is wave Q3c's), the assistant's facts-v4 (wave Q3d), memberships billed as Square subscriptions (each
  `membership_tier_prices` row a plan variation; "Move members").
* **K2e (built, [ADR 0172](0172-square-item-library.md)):** the prices by size are Square's item library: each active priced service a
  Square item with one variation per size at `classPrice` (a range as Square's variable price), a price edit updated in place within
  about 5 minutes, a size turned off hidden, never deleted.
* **Later:** a migration drops `vehicles.vehicle_type`, the member/guest/VIP columns, `plan_credit_rules`, `catalog.tint_matrix`
  and `catalog.guest_markup_pct`.

## Wave Q4 review notes (2026-10-13)

- **F1.** The `website-catalog` seed gives Gold and VIP the inclusions their perks promise, applied by themselves (plan decision 2),
  while the tier covers no active service: Gold 4 hand washes a month (Signature and Exterior Hand Wash); VIP those, Hand wax and
  Engine bay wash every visit, Leather conditioning 2 and Stain removal 1 a month. The owner's own inclusions are never replaced.
  Gold's perks no longer say "Member prices on everything else" (the % off starts at 0, plan decision 3).
- **F2.** `GET /public/catalog/v2` (the website and the assistant's facts) lists no item without a price at any active size, whatever
  its legacy `services.price_cents` (design section 11). Staff bookings keep rule 1's `base` (a service with no cells is charged
  `services.price_cents`): that is this ADR's rule, unchanged here; v1 is unchanged too. (Since the Q4 fix notes below, a `base`
  line asks "Confirm price".)
- **F3.** A price move is never billed sooner than 30 days after its notice: `POST /catalog/tiers/:key/move-members` takes `notice`
  30 to 90, `memberships.price_change_notice_days` is 30 to 90, and the move uses at least 30 days whatever asked for less.
- **F5.** "Confirm price" (`needsPriceConfirm`: the board, the appointment file, the appointment in every answer) reads the add-ons
  too: a live add-on charged its starting price because the visit's size has no price of its own flags the visit like the package.
- **F6.** A staff billing change to the member's own tier and size is refused (409 `MEMBERSHIP_BILLING_STATE`: "use Move members"):
  a grandfathered price moves only with Move members and its notice (plan decision 8).
- **F7.** With `PAYMENT_PROCESSOR=square`, `POST /public/memberships` refuses a tier with no current price at any size (422 on
  `body.tier`, "That plan is not available right now."); with Squarespace the checkout product carries the price, as before.
- **SEC-2.** A size staff set on a car (`vehicle_class_source = staff`) outranks a different size a client, the website or the
  assistant names for it: the visit is priced at the staff size and an internal activity line says what the client chose.

## Wave Q4 fix notes (2026-10-13: the re-verification and the Square sandbox run)

Migration `20261015100100_review_q4_fix.sql`:

- **SANDBOX-F1, what the booking shows as covered is what completion covers.** A tier's inclusions apply by themselves at completion
  by default (plan decision 2): `ensurePlans` creates the default tiers' inclusions with `auto_apply = true` (the column default and
  the seeds already were), and the migration turns it on for the inclusions nobody edited (no `catalog.tier.create` /
  `catalog.tier.update` audit on their tier, no `membership.rule.update` on themselves; production has no members yet). The engine's
  callers price a member with only the inclusions that will cover the visit by themselves (`autoApplied`: `autoApply`, every one for a
  member whose `memberships.auto_apply` is on, and those the visit already redeems): a booking, an added add-on, a size change and
  `POST /appointments/quote`. An inclusion the owner leaves to staff is priced as a member line (the tier's % off) until "Apply credit"
  covers it, so completion never reprices a line the client was shown as "Covered $40 · $20 size difference" down to the member price.
- **F2, staff side (accepted dispute).** Rule 1 keeps the amount: a service with no prices by size is charged `services.price_cents`
  (basis `base`). The line now carries "Confirm price" like an `estimated` one (the package or a live add-on; not a service priced
  on a quote, `quote_only`), on the booking answer, the board, the file and the command core, until staff confirm the size; the
  client's `confirmAtShop` is unchanged. The owner sees which services still need their prices by size.
