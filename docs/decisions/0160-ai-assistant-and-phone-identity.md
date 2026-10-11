# 0160 An AI text assistant on the shop's number, the phone as the client's identity, personal links, status texts and one catalog
Status: accepted (2026-10-10); built in waves W1 (foundation) to W5 (staged rollout)

The owner decided (2026-10-10) that the texting line (the front-desk tablet, ADR 0004) gets an AI assistant that answers anyone 24/7
and books by text; that the client's **phone number is their identity**, proven by a PIN they created or a texted code typed **only
on a personal link page**, never in a text; that every booking is verified (verify once, the phone is trusted 30 days, each in-chat
action is confirmed by a server-generated reply number the model never sees; memberships and payments always need a fresh PIN or
code); that the shop texts the client as the car moves (checked in, running late, ready, picked up); that leads get one automatic
follow-up; and that Settings is the single source of services, prices and categories for the website, bookings and the AI.

The full specification (data model, SMS classes, inbound routing, tools, link API, PIN rules, status texts, website, dashboard,
Bedrock/IAM, must-have tests) is the design document
[docs/design/ai-assistant-and-phone-identity.md](../design/ai-assistant-and-phone-identity.md); the owner decisions in its section 0
are binding.

## Decisions

- **Model**: Claude Sonnet 5.5 on Amazon Bedrock (Converse API, `us.anthropic.claude-sonnet-5-5`, instance-role credentials) behind
  a provider-neutral port (`src/integrations/ports/ai.ts`); `AI_PROVIDER=sim` (default) replays scripted answers, so nothing in
  development or tests reaches AWS.
- **Kill switches**: `AI_ENABLED`, `AI_ACTIONS_ENABLED` (environment), `assistant.enabled` / `assistant.stage` (settings),
  `PUBLIC_LINKS_ENABLED` (404 before validation when off), the link epoch (`links.epoch`), and the per-thread staff pause.
- **Secrets**: `PIN_PEPPER` lives in the Secrets Manager secret (a `SECRET_KEYS` member, never in `/etc/oasis/*.env`), must decode
  (base64, base64url or hex) to exactly 32 bytes, and is required in production once personal links are on. In production the app
  refuses to start with a pepper that did not come from the secret (the loader records the keys it filled, `secretKeysOf`; a value an
  env file set first wins the precedence and is therefore refused), and `install.sh` stops on a `PIN_PEPPER=` line in an env file.
  Outside production a fixed development value stands in, only while `PUBLIC_LINKS_ENABLED` is false.
- **Consent**: a client the assistant creates has the transactional-only opt-in source `inbound_text`; an `inbound_sms` source maps
  to it too, so neither ever counts as marketing consent (`MARKETING_CONSENT` is unchanged). The AI's own replies are consent-exempt
  only as replies: the `ai_reply` class is refused (`no_recent_inbound`) unless that number texted in the last 15 minutes.
  Owner-aligned (2026-10-11): `action_confirm` and `personal_link` are consent-exempt ONLY as replies within 15 minutes of that
  number's last inbound text (the `ai_reply` rule) and never go to an opted-out number; `action_confirm` is refused outside the
  window, a `personal_link` outside it needs normal consent. `enqueueFor` reads the last inbound text and the opt-out itself for
  every reply class, never trusting the caller. Staff cannot send the AI, link or code classes from the dashboard
  (`STAFF_SENDABLE`).
- **Secrets in texts**: links and reply numbers are queued with `secretVars`: the outbox carries the real text, the message row
  (what staff and the event stream see) the masked one.

## Wave W1 (this foundation)

Migrations `20261011000000` to `20261011000500` (catalog fields and categories, the assistant tables, identity, leads, status texts,
membership checkouts), the Kysely types, the environment and settings keys, the consent source, the SMS classes and templates, the
status-texts port (called by nothing yet), the `ai_handoff` and `sms.picture_message` alert kinds, and the AI provider port with its
simulator. No route, job or behaviour beyond the policy gate and the masked message bodies; later waves build the modules.

## Wave W2a (one catalog in Settings)

- **Staff API** `/api/v1/catalog/*` (api-spec section 15.8): a service's website fields, categories (key immutable, the five defaults
  never deleted, a category in use never deleted, at most 20), the tint matrix and guest markup settings, the plans' public label,
  monthly price, perks and Squarespace checkout link. Reads for any signed-in user, writes `set.services` (the existing "Services,
  pricing & checklists" permission; no new permission key), whole-object `PUT`s with a required version like the hours save. The
  routes live under `/catalog` rather than `/settings/catalog` and are registered through `registerCatalogRoutes`, so the Settings
  module list and its contract test stay as they were.
- **One pricing rule** (`src/modules/catalog/pricing.ts`): member = `member_price_cents` else `price_cents`; guest =
  `guest_price_cents` else member + `catalog.guest_markup_pct`, rounded half up to whole dollars (the website's own rounding). Tint is
  priced by the matrix: a tint package names its film by a tag and shows the film's lowest prices. `price_cents` stays what a booking
  charges (the seed sets it to the guest price); charging members their price at booking is a later wave's.
- **Starting prices (design §3b).** An item's member and guest prices (a tint package: its film's lowest) and a tint row's
  `memberMinCents`/`guestMinCents` are the starting prices W3's shop facts and output guard use; the public item's `priceCents` is the
  booking charge, never stated. For an item priced on the website (a member price, or a tint film; not quote-only) `price_cents` is
  kept equal to the guest price by the website-fields save, the markup save and the tint matrix save (`bookingPriceOf`, audit
  `catalog.price.sync`), so the website, a booking and the assistant agree. A guest price needs a member price (422 otherwise).
- **Public catalog** (`GET /public/catalog`) extended in place (every field the website reads today kept): categories, member/guest
  prices, VIP inclusion, quote-only items, the tint matrix, the guest fee, plan prices and perks. Checkout URLs stay internal: only a
  verified membership link leads to one.
- **`appointments.categories`** maintained by `createAppointment`, add-on add/remove and a service's category change (open visits);
  `visitCategory()` gives the chip/KPI word (`mixed` when two categories other than add-ons meet; `mixed` is reserved as a key).
- **Seed `website-catalog`** makes the website's content the production catalog and deactivates (never deletes) the rest; idempotent.
  Durations the design does not give were chosen by the seed (tint 180, interior detail 150, full detail 240, quotes 120/480/300/30
  minutes) for the owner to review.
- **Seed vs members' credits (open owner decision).** Credits redeem on service tags; the seed tags Signature `premium` and Exterior
  `express` (the washes they replace), so every plan redeems what it did before. It leaves the credit rules alone (memberships
  module): the website's Gold/VIP perks ("4 hand washes a month", VIP "everything in Gold") differ from the rules (premium: 2
  premium washes; executive: unlimited express + 2 executive details, the latter covering no website service). Each run logs a
  WARNING per uncovered rule. Not to be run in production until the owner has decided the Gold/VIP credit rules and the memberships
  package has applied them.

## Wave W2b (identity core)

`src/modules/identity/**` builds the services of design sections 1 "Identity" and 5 (links, sessions, PIN, step-up codes, phone
trust, pending in-chat actions, the stale-record rule, revocations), the staff routes `GET /customers/:id/identity` (`cli.view`),
`POST /customers/:id/identity/pin/clear` and `POST /customers/:id/identity/trust/revoke` (`cli.edit`), and the daily retention task
`identity`. No public route: the link API is W3. Migration `20261011020000_identity_core.sql`. Notes on the design:

- **Epoch on the trust**: `phone_trust` gains `epoch` (the links epoch it was granted in), so a `links.epoch` bump ends every trust as
  well as every link and session, evaluated on read.
- **Rolling PIN limits**: wrong PINs are one row each (`identity_pin_failures`), so "10 a day per client" and "20 an hour per
  address" are rolling windows (a fixed-window counter would allow twice the limit across a boundary). A right PIN clears the
  consecutive count of the lockout schedule, never the 24-hour count.
- **Revocation on read**: an opt-out of the number at or after a link's issue or a trust's verification voids it even after START
  (the STOP rule holds whoever records the opt-out); `revokeForOptOut` writes the revocation for the router to call on STOP. The
  number's current owner, the client's phone and PIN versions and the epoch are re-checked on every read too.
- **Uses**: book-again links allow one booking; membership and payment links three completions (a checkout started and abandoned can
  be restarted) and the kind's lifetime; non-verify links allow 20-30 exchanges (the design set only verify/PIN: 5).
- **Pay links** live "until paid/void (≤7 d)" on read: a void invoice revokes the link and its sessions, an invoice with nothing left
  on its balance (`invoice_calc_of`, a payment awaiting the processor included) uses it up; issuing one for a void or paid invoice
  is refused.
- **Permissions**: reading the identity state is `cli.view`, changing it (Clear PIN, revoke trust) `cli.edit`. Design section 8 and
  the plan tie `cli.edit` to Clear PIN only, and the "Website PIN: Set · trusted to …" cell sits on the client file's Overview,
  which `cli.view` opens; the answer is masked (last four digits, no token, hash or code: less than the client file itself, whose
  full number needs `cli.contact`). It follows the client file's other read / write pairs: `GET` / `POST
  /customers/:id/sms-consent` (`cli.view` / `cli.edit`) and `GET /customers/:id/membership` (`cli.view`).
- **Stale records**: texts from the number are never activity (a recycled number's new holder texts from it, and the webhook stores
  that text before the assistant asks), so only the record's creation, an appointment, a verification and a live membership count.
- **Sessions** outlive their link's expiry and consumption within their own 15-minute idle and 1-hour windows, never a revocation or
  a PIN, phone or epoch change. A session opened while the number's trust is live starts verified (by the trust's method) without a
  step-up.
- **Any PIN change** (first set, reset, clear) moves the PIN version: every other link of the client dies (the page that set it is
  re-bound). A reset ends the old trust and trusts the number again from the reset's code; member privileges wait 72 hours
  (`memberPrivilegesHeldUntil`, for W3's membership, payment and VIP checks).
- **Same answer**: a wrong PIN, a PIN where none exists and a stranger's page answer the same 401 after the same HMAC + scrypt work;
  the fifth wrong entry of a page ends it in every case. A lock (429/423) can only follow five wrong entries against a real PIN.
- **Merge**: there is no merge operation in the code yet; `revokeForMerge` is ready for it. A phone change through `updateCustomer`
  bumps `customers.phone_version` and revokes.
- **Email**: the reset notice is the new SES template `pin_reset_notice` through `queueEmail` (no PIN or code in it).
