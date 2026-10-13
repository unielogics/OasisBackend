# 0172 Square item library: services × vehicle sizes kept in step with Square
Status: accepted (2026-10-13, owner plan "NEW PLAN (2026-10-13)", section C: "yes, keep services × sizes in step with Square's item
library"); backend built in wave K2e (package k-items). Off by default (`SQUARE_ITEMS_SYNC_ENABLED=false`); the dashboard block
(DV-911 to DV-913) is wave K3 (package k-items-dash). Builds on ADR 0170 (prices by size), ADR 0171 (Square) and ADR 0173 (tax).
Detailed design: `wt/_reports/k-design-square-items.md` (the plan wins where they differ).

## Context

The counter rings guests up in the Square POS app. Until now the POS kept its own items and prices, Oasis sent payment links as
one-off lines, and a counter payment was matched on its amount alone. The owner wants the POS to show Oasis's services and prices by
vehicle size, so a price changed in Settings → Prices by size is the price the POS charges, and the POS computes the same tax as the
Oasis invoice (ADR 0173: 6.625%, rounded once, half to even).

## Decisions

| # | Decision |
|---|---|
| I1 | **One REGULAR ITEM per active priced service** (packages and add-ons alike; add-ons are items, not modifiers: a modifier cannot be priced per size). `product_type` can never change; APPOINTMENTS_SERVICE would bring Square Appointments in. Quote-only services, services that are off and services with no price at all are not sold: an item Oasis made for one is **archived**; one never made is not made. |
| I2 | **One ITEM_VARIATION per vehicle size**, named after the size, priced with `classPrice` (ADR 0170: the size's own price, the starting price for a size without one). A range ("up to", tint) is **VARIABLE_PRICING** named "Compact car · $229–$279" (the POS asks for the amount). A service without prices by size has one variation, "Regular", at `services.price_cents`. A size that is off is **hidden** (present nowhere), never left out: Square deletes a variation an item upsert leaves out (sandbox), and a hidden one keeps its id and history when the size comes back. |
| I3 | **Categories:** each item is in its Oasis category (the reporting category) and in the fixed **"Oasis"** category. A shop category with the same name (exactly one, case-insensitive) is adopted: referenced, never written. Categories cannot be scoped to a location (sandbox: INVALID_VALUE "Unexpected unit-overridden attribute"), so they are global; items and variations are present at our location only. Square keeps its own ordinal inside a category (it replaced the 3 we sent), so Oasis sends none. |
| I4 | **Ownership.** `square_catalog_links` (per Square environment) is the only set of ids Oasis writes. Oasis owns: item `name`, `buyer_facing_name` (= the website's public name; Square accepts it), `categories`, `reporting_category`, `tax_ids`, `is_taxable`, `is_archived`, presence, the order of its own variations; variation `name`, `pricing_type`, `price_money`, presence, `user_data` (the marker `oasis:v1:<service>:<size or base>`) and no price override at our location. Everything else is kept from Square's current copy (read-modify-write): pictures, descriptions, modifier lists, colours, inventory settings and **every variation staff added** (kept after Oasis's own, untouched). The shop's own items are never written (property test). **Nothing is ever deleted at Square.** |
| I5 | **Oasis wins on the fields it owns.** A Square-side edit of one of them is put back at the next sync and the managers are told once ("Changed in Square: Signature Hand Wash · Large SUV was $45 in Square; Oasis charges $40. Oasis set it back."), again only a day later while it keeps happening. Unlike membership plan variations (ADR 0171), putting back an item's list price moves no money. |
| I6 | **Creates are one UpsertCatalogObject per service through an outbox**, not BatchUpsert: a BatchUpsert whose one batch fails answers 400 while KEEPING its other batches (sandbox 2026-10-13), which would leave items Oasis never heard of. The link row gets the `ct_` key and the exact request body (JSON text: jsonb would reorder keys and Square answers a key sent with another body IDEMPOTENCY_KEY_REUSED) before the call; after a crash or a lost answer the next run sends the same request and gets the same item. Before any create (and for an outbox older than 12 hours) every item is searched for Oasis's marker: an item Oasis made earlier (a crash, a database restore) is adopted, never made twice. An item deleted at Square is made again with a key naming the deleted item (the first key would answer the deleted one). |
| I7 | **Updates are read-modify-write with the versions just read.** Square checks versions per field, nested variations included (sandbox): no version is VERSION_MISMATCH; a stale version is accepted unless a field the request changes was changed since; an upsert that changes nothing keeps the version. On VERSION_MISMATCH Oasis reads, merges and sends once more in the same run, then leaves the item failed for the next run. An update Square already has (a lost answer) is only recorded. |
| I8 | **The tax** (section "Tax" below): the item sync never runs with a tax that differs from Oasis's rate. |
| I9 | **Triggers:** the job `square.items.sync` every 5 minutes at 2, 7, 12 … (offset from `square.catalog.sync`: Square lets one catalog write run at a time), the nightly `square.items.drift` at 04:40, and "Sync now". No hook in the catalog routes: a price saved in Prices by size is in the POS within about 5 minutes. The 5-minute run reads back only what changed (SearchCatalogObjects `begin_time` = the watermark, deleted objects included, linked ids only, Oasis's own versions ignored) and has a fast path (the library fingerprint unchanged, nothing open, nothing changed at Square: no write); the nightly run reads everything linked (BatchRetrieve) and searches every item for the marker. |
| I10 | **Switch:** `SQUARE_ITEMS_SYNC_ENABLED` (default false) on top of `SQUARE_WRITES_ENABLED`. Watch-only (writes off) and with the switch off nothing is written; "Sync now" then answers a read-only **preview** ("would create 41 items with 187 prices") with the tax check. **Rollback:** turn the switch off (the items freeze), then `POST /integrations/square/items/archive-all` (writes on, switch off) archives every Oasis item; turning the switch on again re-sends them all. |
| I11 | **Members are not in Square.** Member prices (whole-dollar rounding) and coverage cannot be expressed as items: members pay through the POS app switch (ADR 0171 R2) or with `INV-…` in the note (R1). |
| I12 | **One writing run at a time** per location and Square environment: a session advisory lock (`itemsLockKey`, scoped to the database schema) around every run that can write. "Sync now" while the job runs (or a 5-minute run while another holds the lock) answers `skipped`, "A Square item sync is already running: try again in a minute", never a false failure or manager notice; the nightly run waits up to 5 minutes for its turn. The preview takes no lock (it writes nothing at Square). |

## Tax

`tax.ts` lists Square's TAX objects (read-only) and compares their `percentage` with `tax.rate_dbp` as **exact decimals** ("6.625"
= 6625 thousandths of a percent; "6.6250" too; more precision than a thousandth never matches):

- `auto` (default): Oasis's own tax when it made one (the sync keeps it as Oasis made it: its percentage equal to Oasis's rate, so
  7% → 6.625% is an update, and enabled at the location, ADDITIVE, in the subtotal phase, never on custom amounts; a staff edit of
  any of these is named in the check's `ownChanged` and in its detail, never "the same as Oasis", put back by the next run like I5
  and told once as "Changed in Square"; an equal percentage written another way, "7.0" for 7, is the same and never re-sent);
  else the shop's one tax that is enabled at the location, ADDITIVE, in the subtotal phase and at exactly Oasis's rate (adopted, never
  changed); else, when the location has no enabled tax at all, Oasis creates "Sales tax" (ADDITIVE, subtotal phase, our location only,
  never on custom amounts); anything else (taxes that do not match, or several that do) is **blocked**.
- `adopt`: the tax staff picked (`PUT /integrations/square/items/tax`); `create`: Oasis's own whatever the shop has.
- A blocked check stops the run before anything is written; the managers are told once a day (`square.items_tax_mismatch`); the status
  row warns; Settings shows the candidates and why each does not fit.
- Warnings: an adopted tax Square also adds to custom amounts (an Oasis total rung up as a custom amount would be taxed twice); Oasis
  rounding new invoices half-up while Square rounds half to even (ADR 0173: until the rollout switches `tax.rounding`).
- **Test connection** gains the check `tax` (read-only), with a CalculateOrder sample of Oasis's own prices ("all 9 sample totals match
  Square to the cent" or "N of M differ by a cent"). It fails Test connection only while the item sync is on.

## Data (migration `20261015200000_square_items.sql`)

`square_catalog_links` and `square_items_state` (docs/data-model.md). Every row belongs to one Square environment (sim, sandbox,
production): switching environments starts with no links, like `square_state`.

## Sandbox findings (2026-10-13, Square-Version 2026-09-16)

| Question | Finding |
|---|---|
| A variation left out of an item upsert | Deleted: RetrieveCatalogObject 404, a batch retrieve with `include_deleted_objects` shows it `is_deleted` |
| A hidden variation (`present_at_all_locations: false`, `present_at_location_ids: []`) | Accepted; Square answers without `present_at_location_ids` |
| Versions | Per field, nested variations too: a stale item version changing `name` after another `name` change is VERSION_MISMATCH ("Field `name` was modified concurrently"); a stale version changing nothing that changed since is accepted; no version is VERSION_MISMATCH; an upsert that changes nothing keeps the version |
| BatchUpsert with one bad batch | 400 with the bad batch's error, and the good batch **is kept** |
| CATEGORY at one location | Refused: INVALID_VALUE "Unexpected unit-overridden attribute for definition present_at_all_locations" |
| `buyer_facing_name` | Accepted and kept on an item |
| Category ordinal | Square replaces it with its own |
| VARIABLE_PRICING | No `price_money`; a FIXED_PRICING variation without one is INVALID_VALUE (field `price`) |
| Archive | `item_data.is_archived: true` is kept; an archived item is still found by search |
| A variation present where its item is not | INVALID_VALUE "… of type ITEM_VARIATION is enabled at all future locations, but the referenced object … of type ITEM is not" (a staff variation of an Oasis item is always at our location) |
| CalculateOrder (ADR 0173 SQR-18) | Catalog lines with an auto-applied catalog TAX are taxed exactly like ad-hoc lines: once on the subtotal, half to even |

The simulator (`src/integrations/square/sim/catalog.ts`, `calculate.ts`) follows every row, and replays all 200 SQR-18 totals.
`pnpm verify:square --items-only` (SQR-15, 16, 17, 19, 20) passed against the sandbox on 2026-10-13 (7 PASS, 0 FAIL), and the end
to end `scripts/e2e-square/run.sh --steps "s8 cleanup"` passed S8a to S8c: the items made, an Oasis price edit on the same Square
variation, and a guest basket's Square CalculateOrder total ($133.28, tax $8.28 at 6.625%) equal to the Oasis invoice.

## Where this differs from the design

- **Creates are one UpsertCatalogObject per service**, not one BatchUpsert of many services: the sandbox showed a failing batch keeps
  the others (I6). The port's `batchUpsert` takes batches (`Extra[][]`) for the scripts that need it.
- **The outbox body is JSON text**, not jsonb (key order).
- **Category ordinals are not sent** (Square replaces them); a new item's order is the order Oasis creates them in.
- **A service with no price at all** (no price by size and `price_cents` 0, as the website catalog starts) is not sold, so not made.
- **A Square-side edit is told again a day later** while it keeps happening (the design had one notice); identical edits within a day
  are put back silently.
- **Archive-all** needs the item sync off first (409 `SQUARE_ITEMS_SYNC_ON`), else the next run would put the items back on sale.
- **Adopting the "Oasis" category by name** after its link was lost (a database restore) adopts it as Oasis's own; an adopted shop
  category is only referenced (a rename in Oasis is then only reported).
- **Oasis's own tax is kept whole**, not only its percentage (enabled, presence, ADDITIVE, subtotal phase, never on custom amounts),
  and **writing runs take a lock** (I12): both after the package review (findings F1, F2).
- Optional phase 6 (the `catalog.version.updated` trigger, POS order lines as a matching signal, R4b) is not built.

## Rollout

1. Square production token from the shop's account, webhook (ADR 0171), then the observe-only week: Settings → Billing &
   integrations → Square item library shows the preview and the tax check; Test connection shows the `tax` check.
2. The shop's Square tax must be 6.625%, ADDITIVE, at the location (or none: Oasis then makes "Sales tax"); Oasis set to 6.625% with
   `half_even` (ADR 0173 rollout).
3. `pnpm verify:square --read-only` (SQR-20, the production pre-flight: the shop's taxes against Oasis's rate and the item count;
   SQR-20 has no database, so what the sync would create is the Settings preview: Sync now while watch-only).
4. `SQUARE_WRITES_ENABLED=true` and `SQUARE_ITEMS_SYNC_ENABLED=true` (still `PAYMENT_PROCESSOR=squarespace`): items appear within 5
   minutes; check the counts; add the Oasis categories to the POS home grid on each device.
5. Then links and refunds, cards and fees, memberships, the processor (ADR 0171).

## Tests

`test/square-items/plan.test.ts` (desired library; property tests: converges, never deletes, never writes a foreign id, keeps staff
variations, presence, prices by the rule, variation ids kept through size changes, keys ≤ 45, a failing tax plans only `blocked`),
`test/square-items/tax.test.ts`, `test/square-items/sync.test.ts` (database: every scenario of design section 9),
`test/square/sim-items.test.ts` (simulator fidelity and the 200 SQR-18 totals), `test/jobs/matrix-square-items.test.ts`, the routes'
authz (generated matrix) and `test/square-db/routes.test.ts` (Test connection `tax`).
