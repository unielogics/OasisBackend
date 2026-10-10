# 0150 The public website books for real: a small public API with abuse controls, no card capture, and SMS as the dependency
Status: accepted (2026-10-10); amended the same day after the public-surface review (section "The review of 2026-10-10")

The owner decided (2026-10-10) that the website (ADR 0145) books **real** appointments and signs members up, with "book now, pay at the
shop or by link": no card data is ever typed on the site. The open-times board shows **real** availability, the "N of 3 bays open now"
pill real counts, and the dashboard sees a web booking like any other. This ADR records how that surface is built and bounded.

## The surface

Six routes under `/api/v1/public/` beside the hours route, every one `access.public(reason)` and listed on purpose in the authz
matrix: `GET availability`, `GET catalog`, `POST otp`, `POST otp/verify`, `POST bookings`, `POST memberships` (api-spec section 26).
They live in one module (`src/modules/public`) wired in `src/http/modules.ts` with the **same** invoice gateway, membership port,
alert source and messaging queue the scheduling module gets, so a web booking goes through `createAppointment()` unchanged (the
slot guard under the per-date lock, the invoice, the checklist snapshot, the audit row, the ops events) with `source: 'online'` and
the **online** channel's rules (lead time, booking window, paused days) and no override: there is nobody to grant one. The acting
party is "Website" (no user, no employee, no permission).

## What a visitor may learn

Nothing about people or jobs, and nothing about a number to a caller who has not verified it: a booking's answer (`member`,
`deposit`, `confirmationBy`, the slot refusals and the window they name) and a join's answer are the same for a member's, a VIP's, an
opted-out or an unknown number. The board is a projection of the slot engine's answer for an online, non-VIP caller reduced to four
states (`open`, `last`, `vip`, `booked`) with the free-bay count; closed days carry only the name customers are told anyway. The
catalog is names, keys, durations and prices. The member view after a verified code is the first name, the website tier, the washes
left and whether the membership is active. Problem copy is the design's ("That time was just taken. Pick another.", "4:00 PM is held
for VIP members. Join to book it with no fee.") and never the dashboard's override hints. A code request answers 202 whether or not
the number is known or the text could go out.

## Identification by phone and one-time code

A member is whoever can read a text at the member's number: `POST otp` texts a six-digit code (class `otp_code`: transactional,
consent-exempt, sent even to a number that texted STOP because the person is asking for it right now, never held by quiet hours,
no footer, body redacted in the Messages tab like a password reset), `POST otp/verify` turns it into an opaque 30-minute token.
Codes and tokens are stored as SHA-256 hashes (the code's hash is salted by its challenge id), a code lives 10 minutes and allows
three tries, a number has one active code, a token is bound to the number and to the customer owning it at verification. Why not
sessions or passwords: the website has no accounts (decision of the design), and the shop already talks to customers by SMS.
The token is the only proof of the number. With a token issued for the customer who owns the number, a booking or a join may change
that customer's record (name, email, consent, vehicles, a membership) and use the member's and the VIP's privileges (no booking fee,
VIP-held times, the VIP online window). Without it, the shop's existing customer is linked by id and left exactly as it is, and the
caller is a guest and not a VIP, whatever the record says. Codes are lane 1 (beside the confirmations and payment links, never in
lane 0's reserve) and capped per rolling hour for all callers together (`PUBLIC_OTP_TEXTS_PER_HOUR`, default 12; past it 429
`PUBLIC_CODES_PAUSED` and one notification an hour to the managers), and they go only to US and Canadian numbers that can take a text
(no other +1 country, no premium-rate or toll-free area code: 422).

## Abuse controls

Three rings: nginx's zones, the same on the website's host and on the dashboard's (`oasis_api` with a 60-second cache under a fixed
key for the three GETs, the stricter `oasis_public_post` and a 16k body limit for the writes, cookies stripped both ways; on the
website's host every other `/api` path is a 404), the API's in-memory per-route limit per address, and **durable** fixed-window
counters in `public_rate_limits` (shared by every API process), charged in the order address, number from that address, number, and
stopping at the first refusal: codes 10 / 3 / 5 every 10 minutes, bookings 10 / 3 / 5 an hour, joins 10 an hour / 2 / 3 a day. A call
refused for its address costs the numbers it names nothing, and no single address can use up a number's allowance. A booking refused
for its slot still counts. The cacheable reads take their query in one spelling (an unknown, repeated or encoded parameter is 422), so
a cache-busting parameter never reaches the slot engine. The two record-creating POSTs require an `Idempotency-Key` (the site
generates it when the sheet opens) and carry a honeypot field (`website`) that answers 202 with a fake reference and writes nothing.
The website's `Origin` is allowed through `PUBLIC_SITE_URL`; a request without `Origin` and without a cookie was never blocked.
The writes are closed by default (`PUBLIC_WRITES_ENABLED=false`: the same 404 as an unknown route, before validation, on both
hosts): they open only with live online booking, once the SMS tablet sends texts (the review's findings on unverified writes,
enumeration and limits are resolved below).
Expired codes, tokens and old windows are dropped by `maintenance.purge`.

## No card capture, the fee, and memberships

Money stays where ADR 0003 put it. A guest owes the shop's booking fee (`booking.guest_fee`, default $25, collected at the counter
or through a Squarespace payment link staff text after the booking: the dashboard's existing payment-link flow, kind deposit); an
active member who verified the number (a member token) owes nothing. The answer and the activity log say so; nothing is charged online. Joining (a new number, or the owner of an existing record with a token) creates the customer, the
vehicles and a membership in the **pending** state under the dashboard's plan the tier maps to (`gold` = `premium`, `vip` =
`executive`, sold as "Gold" / "VIP"), with the mapped Squarespace product's key when the product map has one. Squarespace has no
checkout-link API, so staff get a notification asking them to text the link (naming the product, or saying the map has none, with
an open `product_map_empty` alert); the existing sync activates the membership when the paid order arrives, which is why the row
leaves `manual_status_at` null. The site keeps the design's prices as content; the plans carry none.

## The SMS dependency and the site's switch

Codes and confirmations are texts, and texts need the tablet (ADR 0004), which the owner wants last. The API is complete now; the
site carries a build-time flag `SITE_BOOKING` (`sms`, the launch default: Book / Join / "Pay & book" fall back to the design's own
`sms:` and `tel:` links with a prefilled message built by the same sheet; `live`: the real calls). Outside production a text to a
number off `SMS_ALLOWLIST` is suppressed as every text is, so a staging site cannot complete a code flow for an arbitrary number by
design.

## Deviations from the first contract, recorded here

`source` is the existing enum's `online` (no new value); `bayCount` is the bays still free for that time after the booking; the
grid ends at the last start the shop's cutoff rule allows (the engine's rule, not "closing minus the duration"); days carry a
`reason`; the board answer adds `now` (the pill) and the booking answer adds `service`, `addons`, `when`, `member`; the member view
adds `plan` and `active`; plans carry `priceCents: null`; `GET availability` takes the website's catalog keys, not ids.

## The review of 2026-10-10

A 104-agent adversarial review of the public surface confirmed fifteen findings; all are fixed with tests (branch
`ws/s4-public-fixes`), none of them was reachable in production because the writes were closed:

* **Pool deadlock.** The two record-creating POSTs held the idempotency transaction's connection while resolving the location, charging
  the limits and reading the honeypot's fee on the pool. `idempotentHandler` gained a `prepare` step (after the claim, before the
  transaction, never on a replay; what it throws releases the key): the pool work moved there and the command uses only `tx`
  (`test/public-http/pool.test.ts`: six bookings and three joins at once from one address on a two-connection pool). Defensively, a
  full pool fails a checkout after `DB_CONNECT_TIMEOUT_MS` (10 s) with 503, and a session the server ends while checked out no longer
  crashes the process.
* **Unverified writes.** An existing customer's record changes only with a token issued for that customer (above). A booking is linked
  by id, and what was typed goes on the appointment's internal log; a join writes nothing, texts nothing and asks the managers to
  confirm (`membership.web_join`, audit `membership.web_join_unverified`), answering the same 201.
* **Consent grade.** The website's opt-in (`sms_opt_in_source = online`) is the consent kind `web_booking`: confirmations, reminders,
  receipts, never marketing (`canSend.ts`); previously it mapped to the marketing-grade `web_form`.
* **Privileges and enumeration.** No fee, VIP-held times and the VIP window need the token; a verified active member of the plan the
  website sells as VIP counts as a VIP for the slot rules (the staff's `vip_clients` list still does too); the answers do not differ by
  what the shop knows about an unverified number (`confirmationBy` is what was asked for).
* **Texts.** US and Canadian mobile-capable numbers only; `otp_code` in lane 1; the hourly ceiling on codes.
* **Limits.** Ordered, stopping at the first refusal, with the per-number-per-address twins.
* **Caches and nginx.** Strict, canonical queries on the three reads; a fixed `proxy_cache_key`; the dashboard's host applies the
  website host's rules to `/api/v1/public/`.
* **Input.** An impossible date is 422 (it was a 500); a booking's start must be on the board's grid (4:05 PM slipped past the exact
  4:00 PM VIP hold check).

Left to the website (repository `unielogics/OasisSite`): its slot lock rule (`locked` for anyone who is not a verified VIP), offering
the code step before a join or a booking with a known number, and the copy of the "held for VIP members" note for a verified Gold
member. The problem copy here is unchanged.
