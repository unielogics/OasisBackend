# 0150 The public website books for real: a small public API with abuse controls, no card capture, and SMS as the dependency
Status: accepted (2026-10-10)

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

Nothing about people or jobs. The board is a projection of the slot engine's answer for an online, non-VIP caller reduced to four
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
sessions or passwords: the website has no accounts (decision of the design), the shop already talks to customers by SMS, and the
token's only privilege is "no fee, and you may correct your own name and email".

## Abuse controls

Three rings: nginx's zones on the website's host (`oasis_api` with a 60-second cache for the three GETs, the stricter
`oasis_public_post` for the writes, cookies stripped both ways, every other `/api` path a 404), the API's in-memory per-route limit
per address, and **durable** fixed-window counters per phone and per address in `public_rate_limits` (one upsert per request, shared
by every API process: 3 codes per number and 10 per address every 10 minutes, 5 bookings an hour per number and 10 per address, 3
joins a day per number). A refused booking still counts. The two record-creating POSTs require an `Idempotency-Key` (the site
generates it when the sheet opens) and carry a honeypot field (`website`) that answers 202 with a fake reference and writes nothing.
The website's `Origin` is allowed through `PUBLIC_SITE_URL`; a request without `Origin` and without a cookie was never blocked.
Expired codes, tokens and old windows are dropped by `maintenance.purge`.

## No card capture, the fee, and memberships

Money stays where ADR 0003 put it. A guest owes the shop's booking fee (`booking.guest_fee`, default $25, collected at the counter
or through a Squarespace payment link staff text after the booking: the dashboard's existing payment-link flow, kind deposit); an
active member owes nothing. The answer and the activity log say so; nothing is charged online. Joining creates the customer, the
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
