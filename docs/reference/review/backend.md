<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Adversarial coverage review: Oasis Auto Spa "backend" design

## (A) Verdict

The design is strong and mostly implementable. The money model, RBAC resolution, state machines, seeds and golden vectors are precise. I re-derived about 15 of the golden numbers by hand and they hold: the tax rounding vectors, INV-20602/20571/20566/20560, the 20506 lowest-id arithmetic, and the 7d refund totals.

I sampled 80 concrete items across the three screens and the integrations. 41 are covered precisely. About 35 are gaps or underspecified, shown in (B), and 12 are risky external assumptions. The rest hold with minor caveats, and 6 statements are wrong or contradictory (C).

Sampling ledger: ✔ means covered precisely. ✖ means a gap and points to the (B), (C) or (D) item.

- **Operations (30 items)**
  - ✔ advance transitions and messages
  - ✔ assign-to-bay guards
  - ✔ start-without-bay fix
  - ✔ est-completion fix
  - ✔ late rule
  - ✔ canDrag and reschedule guard
  - ✔ Bay-time-free formula
  - ✔ alerts 1–9, and new alerts 10–12
  - ✔ arrival card, prep-bay and simulate-arrival
  - ✔ search scope
  - ✔ calendar closes today
  - ✔ genDay and dayCount PRNG
  - ✔ toggleAddon `added` flag
  - ✔ stable checklist ids
  - ✔ membership tab
  - ✔ history tab
  - ✔ emergency banner
  - ✔ theme preference
  - ✔ togglePay mapped to void
  - ✔ pickup toggle
  - ✖ "12 booked" parity (B4)
  - ✖ Pending payments (B4)
  - ✖ Revenue today (B3)
  - ✖ Week window (B27)
  - ✖ closed day with existing bookings (B24)
  - ✖ new-appointment slots, date and walk-in (B27)
  - ✖ payment-link quick reply has no URL (B9)
  - ✖ photos HEIC and size cap (B33)
  - ✖ bell dot (B26)
  - ✖ staff columns (B25)
- **Payments (20 items)**
  - ✔ tax half-up in cents
  - ✔ range semantics
  - ✔ chart buckets
  - ✔ by-method
  - ✔ filters, search and sort
  - ✔ pending banner
  - ✔ adjust formula and settlement
  - ✔ credit-issue expiry
  - ✔ collect and apply credit
  - ✔ by-item refund
  - ✔ CSV spec
  - ✔ locked state and the Support path
  - ✔ limit resolution
  - ✔ pay.void
  - ✔ approve and deny rules
  - ✖ status ladder (C2, B2)
  - ✖ FIFO credit (B1)
  - ✖ receipt content (B35)
  - ✖ idempotency scope (B7)
  - ✖ ledger ordering (B31)
- **Settings (14 items)**
  - ✔ hours validation
  - ✔ closure preview and error strings
  - ✔ employee schedule 422
  - ✔ roles CRUD and limits
  - ✔ arrival settings
  - ✔ effective permissions
  - ✔ view-as
  - ✔ emergency close and reopen
  - ✖ booking rules save (B22)
  - ✖ federal holidays (B24, C5)
  - ✖ invite flow (B18)
  - ✖ last Super Admin (B19)
  - ✖ VIP clients by name (B37)
  - ✖ checklist editing (B23)
- **Integrations and cross-cutting (16 items)**
  - ✔ seed id-collision fix
  - ✔ UTC and business-tz handling
  - ✔ session and CSRF
  - ✔ STOP/START router
  - ✔ webhook HMAC (marked "verify")
  - ✔ aarch64 stack, except the HEIC point
  - ✖ Squarespace sync (D1)
  - ✖ order matching (B10)
  - ✖ memberships (B11)
  - ✖ SMS Gate send and idempotency (D2)
  - ✖ Tailscale HTTPS (D3)
  - ✖ SES (B34)
  - ✖ SSE (B32)
  - ✖ hold-release golden vector (C1)

The main weaknesses are in six areas:

- **Ledger edge cases:** credit allocation, canceled and no-show invoices, and the invoice date freeze.
- **Parity:** invoices created at booking conflict with the Operations parity numbers.
- **Card money under Squarespace:** it is counted as paid before any money moves.
- **SMS tablet operations:** lanes, caps, unknown senders and the setup runbook are underspecified.
- **Missing UI:** the backend builds commands and endpoints that the designs have no screen for.
- **Auth completeness:** bootstrap, lockout and privilege-escalation protections are missing.

## (B) Uncovered or underspecified items

| # | Item | Source | Why it matters | Fix to add |
|---|---|---|---|---|
| B1 | Store-credit FIFO as a retroactive running-sum view | pay-domain §2.9, A4; design §3.9 | A new apply is allocated by cumulative sum, so it can hit a lot that was already expired. Example: lot A = 25 (expires day 30), lot B = 20 (no expiry). Apply 10 on day 10, then apply 10 on day 40. The view assigns both to A, leaving B at 20 when it should be 10. The balance is overstated. | Add an append-only `credit_allocations(apply_event_id, lot_id, cents)` written at apply time, skipping lots expired at that instant. Balance is Σ(lot) − Σ(alloc) over non-expired lots. State that refund-to-credit lots have no expiry. |
| B2 | Canceled, no-show and kept-deposit invoices | pay A17; design §3.9 and §4.1 | A canceled invoice with a kept deposit falls through to `'paid'`. No-show leaves the invoice unpaid forever, which pollutes Outstanding. Gross and Net count unperformed work. | Add statuses `canceled_kept` and `canceled`. On `no_show`, cancel the invoice with reason `no_show`. Net for canceled invoices is the retained deposit. Keep the design's formula only under a parity flag. |
| B3 | `occurred_at` and `biz_date` freeze at the first ledger event | design §3.7 | A deposit paid at booking moves the invoice to the booking date, so Payments "Today" and Revenue today miss the job. Revenue today is also invoice-basis but labelled "collected". | Freeze `biz_date` on completion or service date, and keep per-event `occurred_at`. Define Revenue today as cash-basis, the sum of events occurring today, and say so. |
| B4 | Operations parity vs "invoice at booking" | cc-domain §3.6; cross §2.1(6) | The design shows Pending payments 6 / $1,299. The parity seed omits three invoices, so the real calc gives 3 / ~$507. Golden vectors conflict. | Define two profiles: `parity-ops` (invoices for all 11, cent-level totals, with recomputed expected KPIs such as $1,298.53) and `parity-pay` (the 105-invoice set). Or declare the deviation explicitly. |
| B5 | No golden vectors for Operations; no parity environment | design §10.1 and §9; runtime §5 | Two of the three screens have no numeric tests. A frozen-clock parity run must not touch the production DB. | Capture KPI, alert-order, bay-card, dayCount and `renderVals` snapshots from the original bundle in the Playwright harness. Run a separate `oasis_parity` DB and API instance with `CLOCK_FREEZE_AT`. |
| B6 | `advance` picks the next step from server state | design §5.3 | A stale screen, a double click or a swipe skips a state (confirmed → cleaning). | Require `expectedStatus` in the body. Return 409 `STALE_STATE` with the current status. |
| B7 | Idempotency scope and key lifecycle | design §1.4 | Cancel-with-refund, membership-perks apply, confirm-processor, payment-links and receipt are not under `/invoices/**`, so they are unprotected. Keys generated at submit time defeat double-click protection. | Make the key mandatory on every money-effecting route. The dashboard generates it when the sheet opens and reuses it until success or cancel. |
| B8 | Collect UX under Squarespace | pay §4.4; design §4.3 | The "Card on file" label implies a charge, and the toast says "Collected". Staff may release the vehicle with nothing charged. The 24h alert is too late. cc "Mark Paid" has no tender choice, so the card default will mislabel cash. | Keep the design strings but add an "Awaiting Squarespace" pill. Use the toast "Recorded $X · complete in Squarespace". Alert at 2h or closing time, and add an end-of-day unconfirmed-card report. Ask cash or card for cc Mark Paid, or default to the last tender. |
| B9 | Payment-link amount and tax | design §7.1 | Squarespace applies its own tax and fixed product prices, so the ±1¢ match fails. `SQSP_PAYMENT_LINK_TEMPLATE` cannot carry an arbitrary balance. cc modal "Send payment link" and the quick reply have no URL field. | Document the procedure: a tax-inclusive product with tax off. Make match tolerance configurable. Replace "template mode" with fixed deposit products ($25, $50). Add the URL input to the cc modal and the quick reply. Allow-list link hosts. |
| B10 | Match precedence and webhook dedupe | design §7.1.2–4, §3.1 | A staff-recorded card event plus a link order can double-count. `webhook_log.external_id` would drop distinct updates if it were the order id. Test-mode orders pollute the ledger. | Match order: existing `awaiting_processor` event (same customer and amount, within 48h), then link, then manual. Never create a second `pay` event. `external_id` is the notification id. Ignore `test_mode` unless a flag is set. |
| B11 | Subscription identity and membership heuristics | design §3.8, §4.6 | The source of `sqsp_subscription_ref` is unknown. A full refund is not a cancellation. Squarespace retries failed payments, so `past_due` after 3 days will misfire. | Derive the key from the profile email plus product id. Make the grace period configurable. Treat refunds as a flag for review, not as cancel. Do an adapter spike first. |
| B12 | Plan credit rules and tags unseeded | cc-domain §1.7; design §3.8 | The tag vocabulary and rule rows for Essential, Premium, Executive and Exotic are undefined. | Enumerate tags (express, premium, executive, handwash) and the rule rows: 2 express, 2 premium, unlimited express + 2 executive, unlimited hand washes. Seed discount bp 1000/1500/2000/2500. Define `memberMonths`. |
| B13 | SMS eligibility, quiet hours, segments | design §3.4, §7.2 | `sms_opted_in=false` vs `sms_opt_outs` is ambiguous. Reminders could go out at night. The ⭐ in `review` forces UCS-2. Multipart cost is untracked. | Add one `canSendSms(customer, purpose)` matrix. Add `sms.quiet_hours` for non-transactional messages. Store a segment count. Strip emoji by default. |
| B14 | Unknown-sender stubs and inbound attribution | design §7.2 | The SIM receives carrier, 2FA and spam texts, which would create junk customers. Inbound with no active appointment is invisible. | Quarantine unmatched senders in `sms_inbox` and create no customer row. Attach inbound to the next upcoming appointment, else the last completed one within 14 days. Notify on unattributed inbound. |
| B15 | Dispatcher lanes and caps | design §7.2 | An emergency blast at P0 starves ready-for-pickup. 120/h may exceed Android's SMS usage threshold. | Reserve capacity for transactional P0, and put the blast in its own lane. Default cap ≤ 60/h and test on the device. |
| B16 | Tablet and Tailscale runbook | design §11.3 | Not specified: SIM and SMS capability, battery optimization, auto-start, static tailnet IP, ACLs (host→tablet:8080, tablet→host:443). Tailscale node keys expire (about 180 days by default) and silently break SMS. | Add a setup checklist. Disable key expiry on both nodes. Add a health alert for `app:started` without a reboot. |
| B17 | First-user bootstrap and dev logins | design §9, §11.3 | No way to create the first Super Admin. Parity seeds need known passwords. | Add `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` or a `cli user:create` command. `/dev/seed` sets dev passwords for e1–e6. |
| B18 | Invite flow identity | design §3.2, §5.1 | Employee email is nullable but `users.email` is required, and `invite/accept` has no email. Phone is not normalized. | Require email at invite or accept it in the accept payload. Add `phone_e164` and the design's inline error strings. |
| B19 | Last Super and escalation | design §5.2, §6 | An owner lockout is possible. A `team.roles` holder (Management) can raise its own limits to "No limit", grant `set.billing`, or assign Super. | Invariant of at least one active Super. Only Super may change limits, assign Super, or grant `set.billing` and `pay.void`. Block self-deny of `team.roles`. Audit alert on changes. |
| B20 | Admin password reset | design §5.1 | SES sandbox blocks reset email for unverified staff. | Add `POST /employees/:id/password-reset` that sends an SMS link. |
| B21 | Screens absent from the designs | design §5.1 | Login, invite-accept, forgot/reset, 403 and error states do not exist in any design, yet the backend needs them. | List them for user sign-off, in the same visual language. |
| B22 | Booking rules and federal toggle | design §5.2; set §2.8 | The design's rules are not in the dirty bar. The backend saves them with hours, which changes behaviour. No GET returns the federal toggle. | Give rules an immediate-save endpoint, or add them to the dirty bar. Return `federalAuto` in `GET /closures`. |
| B23 | Auto-save granularity | set §2.8; design §5.2 | Per-keystroke checklist PUTs trigger sync storms. Limit-chip cycling persists intermediate "No limit" values. The DCLogic port sends `string[]`, so ids are lost. | Commit on blur or Enter, and debounce chips. Add `version` to checklist PUTs. The client carries `{id,label}`. Server fallback diff by position. |
| B24 | Federal-holiday and closure notification safety | design §4.8; set Q3 | The default `notify=true` on generated closures messages customers, and rec #9 adds six holidays the design never had. Closed days with bookings are hidden in the calendar. Semantics of the notify toggle and of delete are undefined. | Generated closures default `notify=false` and skip past dates. Calendar summary returns `needsRebook`. The notify toggle only affects send-at-create. Delete sends nothing. |
| B25 | `bay_staff` derivation | cross #21, #23 | Settings has no field for it, so new detailers never appear in the cc columns. | Derive from the Crew role or effective `jobs.status`. Define the layout for more than 4 columns. |
| B26 | Bell dot lifecycle | cc-ui §6 | No list UI exists, so the dot would stay lit permanently. | Define auto-read on viewing Ops, or hide the dot until a UI is approved. |
| B27 | New-appointment panel, walk-in, Week window | cc-domain §3.3, §3.12, §4 | The panel shows 8 slots and has no date picker, but the engine returns about 20. Walk-in `start=now` has no capacity semantics. `week` is undefined. | Show the next 8 non-past slots of today in a scrolling list. Walk-in rounds up to the next slot and checks capacity. Define `week` as today through today+6. |
| B28 | Copy catalog and 403 UX | design §1.4 | The new guards have no title or detail strings. | Add copy for `NOT_TODAY`, `BAY_UNAVAILABLE`, `ADDON_REMOVE_OVERPAID`, `ITEM_ALREADY_REFUNDED`, `SELF_APPROVAL`, `STALE_STATE`, plus 403 copy. |
| B29 | Search PII oracle | cc-domain §3.12 | Without `cli.contact`, searching by phone leaks matches. | Exclude phone and email tokens from `q` when `cli.contact` is missing. |
| B30 | Read-model shapes | design §5.3 | `/ops/snapshot` card fields and the employee and role list shapes are not enumerated. | Publish the zod schemas from cc-ui §6.3 (card VM) before the UI port. |
| B31 | Ledger ordering | pay §4.6 | The design reverses insertion order. Late Squarespace events carry earlier `occurred_at`. | Order by `occurred_at desc, seq desc`. |
| B32 | SSE resync, fallback and time-based alerts | design §5.7, §8 | Events are purged after 10 minutes, so a longer gap loses updates. Arriving-soon and KPIs change with time but emit nothing. | Add a `resync` event and refetch on reconnect and on visibility. Add a 30–60s fallback poll. Run a per-minute alerts scan that emits on hash change. |
| B33 | Photos | design §7.4 | sharp's prebuilt binaries lack HEVC decode, so HEIC thumbnails fail. A presigned PUT cannot cap size. | Use presigned POST with `content-length-range`. Convert HEIC client-side or reject it. |
| B34 | SES details | design §7.3 | SNS subscription-confirmation handling is missing. Domain and DKIM setup is unlisted. The receipt email template is undefined. | Handle `SubscriptionConfirmation`. List the SES domain, DKIM and IAM role. Define the receipt HTML. |
| B35 | Receipt content | pay §4 | SMS receipts have no link or lines. | Short SMS summary plus a full email. |
| B36 | Tax liability report | design §3.9 | Tax refunded is not tracked per event. | Add a report formula, or store `tax_cents` on events. |
| B37 | VIP-by-name and household phones | design §5.2, §3.4 | A name-only add can make the wrong person VIP, or create a stub that later duplicates. Unique phone blocks two customers on one phone. | Return 409 with candidates, or use a typeahead (flag as a UI addition). Use `unique(phone, lower(name))`. |
| B38 | Emergency edges | design §4.7 | "Rest of today" after closing time is undefined. The `oasis.spa/r/CODE` short domain does not exist. | Reject with a clear error. List the short-domain prerequisite. |

## (C) Incorrect or contradictory statements

1. **C1, hold-release vector.**
   - Quote: "a Sat 8:00 hold with `release=48` is `vip_held` for non-VIP at Thursday 8:01".
   - Design §4.2 says `vip_held` while `now < S − release`. S − 48h is Thursday 8:00, so at 8:01 the slot is available.
   - Fix: use Thursday 7:59 for `vip_held`.
2. **C2, status ladder.**
   - Quote: `'canceled' -- fixes the design quirk`.
   - A canceled invoice with a kept deposit (paid > 0, refunded = 0, balance forced to 0) reaches the `else 'paid'` branch.
   - Add a `canceled_kept` case (B2).
3. **C3, credit FIFO.**
   - Quote: "implemented as the view `customer_credit_lots` with running-sum windows".
   - It mis-allocates after expiry (B1). Use a materialized allocation table.
4. **C4, invoice date freeze.**
   - Quote: "`occurred_at` follows the appointment start until the first ledger event, then freezes".
   - A booking-time deposit moves the invoice date (B3).
5. **C5, closures schema.**
   - Quote: "unique `(location_id, federal_key, year)`".
   - The `closures` table has no `year` column. Either add it or embed the year in `federal_key`.
6. **C6, dispatcher.**
   - Quote: "The SMS dispatcher is not a pg-boss job" (§1.1) versus `sms.dispatch` in the §8 job table.
   - Also, `pg_try_advisory_lock` and `LISTEN` need dedicated non-pooled connections.
7. **C7, view-as and self-approval.**
   - Quote: "Writes are allowed, because the Payments design needs them to demonstrate the approval flow".
   - But self-approval is blocked unless the approver has an unlimited limit. A Super viewing as Management (limit 1000) cannot approve a request created as Support.
8. **C8, user email.**
   - `users.email citext unique` conflicts with optional employee email and with `invite/accept {token,password}` (B18).
9. **C9, invoices and reconciliation.**
   - Quote: "Invoices exist from booking, so Pending payments and Outstanding reconcile".
   - The parity seed has no invoices for the three unpaid customers, so they do not reconcile there (B4).
10. **C10, undefined or unused config.**
    - `lead_min` is not defined in `booking_rules` or `settings`.
    - `btree_gist` is listed but no exclusion constraint uses it.
    - The Collect method name `card` differs from the design's `card_on_file`.
11. **C11, token refresh.**
    - `sqsp.token.refresh` is scheduled "daily", but OAuth access tokens are short-lived (verify). Refresh on demand and on 401.

## (D) Risky assumptions and mitigations

- **D1, Squarespace API.** Items marked "recollection" must be verified in a spike against a trial site before building.
  - Orders and Transactions may require both `modifiedAfter` and `modifiedBefore`, while the port treats `modifiedBefore` as optional.
  - Webhook Subscriptions is probably OAuth-only.
  - The per-site rate limit may be about 300 requests/hour. Pagination plus the nightly 45-day reconcile needs a request budget.
  - There may be no unpaid order state.
  - Transactions likely expose the brand but not last4 or wallet. Production methods will therefore show "Visa" with no ••digits, and the Apple Pay bucket will be empty.
  - Subscription orders may carry no subscription id (B11).
  - Confirm the plan tier and the key scopes.
  - Mitigation: write the contract tests against a trial site first.
- **D2, SMS Gate API.**
  - The route name (`/message` vs `/messages`), the body shape, and whether a client-supplied `id` is accepted are unverified.
  - Resolving an ambiguous timeout by `GET /messages/{id}` relies on that unverified assumption.
  - Mitigation: spike against the real tablet. If `id` is not honoured, dedupe on `(to, body, time window)` against the device list.
- **D3, HTTPS and the host stack.**
  - `tailscale serve --https=443` coexisting with nginx on 443 is unverified.
  - `serve` maps all paths, which exposes `/api` to the whole tailnet. Use `--set-path /hooks/smsgate`.
  - Prefer a dedicated API listener on `127.0.0.1:3002` for hooks over a Host-header check. A spoofed `Host: <host>.ts.net` on the public listener should not matter, but removing the dependency is cleaner.
  - The SMS Gate local server must bind to the tailnet interface. Test with curl.
- **D4, Android and SIM limits.**
  - The tablet needs a SIM that can send SMS.
  - Android's SMS usage monitor prompts after a threshold (verify on the device). A prompt blocks sending silently until dismissed.
  - Keep volume low. The consumer-SIM carrier-filtering risk is already flagged.
- **D5, card money counted as paid.** `awaiting_processor` events count as paid immediately, so Paid status and revenue can precede real money. Mitigation is B8.
- **D6, performance on 2 vCPU.**
  - `invoice_calc` aggregates the whole `ledger_events` table per query. Use a per-invoice lateral function, or filter by range inside the CTE.
  - Every SSE event can trigger every client to refetch `/ops/snapshot`. Coalesce on the client (500ms) and add an ETag.
  - Playwright Chromium runs can starve the API. Run them off-hours or in a cgroup.
  - Use a dedicated LISTEN connection.
- **D7, aarch64 and pins.**
  - `@node-rs/argon2` and sharp arm64 prebuilts are fine.
  - HEIC is not supported (B33).
  - Install pnpm explicitly if corepack is absent from the AL2023 Node package.
  - Pin Next 14.2 with React 18.3.1. Next 15's App Router requires React 19. Render client-only for parity.
- **D8, backups.** Nightly `pg_dump` means up to a 24-hour RPO on a payments ledger. Add EBS snapshots or WAL archiving, and test a restore. `SECRETS_KEY` loss makes integration credentials unrecoverable, so store it in SSM.
- **D9, login lockout.** Locking an account for 15 minutes after 10 failures lets anyone lock out a known email. Use per-IP and per-account throttling, and exempt the owner.
- **D10, short reschedule codes.** 8-character base32 is 40 bits, which is enumerable at 20/min per IP across many IPs. Use at least 12 characters.
- **D11, no external monitoring.** The "device down" alerts live in the same app. Add an external uptime check on the API and host.

## (E) Top 10 changes before implementation starts

1. Replace the credit view with materialized allocations and fix the expiry semantics (B1, C3).
2. Fix invoice status, date and basis rules (B2, B3, C2, C4).
3. Split the parity seeds and capture Operations goldens from the original bundle in a separate parity environment (B4, B5).
4. Add safety around card money (B8, B9, B10): copy and pill, shorter alert, match precedence, and fixed deposit products.
5. Make `advance` require `expectedStatus`, and extend idempotency to every money-effecting route with client key lifecycle (B6, B7).
6. Complete auth (B17–B21): bootstrap, last-Super protection, escalation limits, admin SMS reset, the `users.email` contradiction, and a sign-off list of the missing screens.
7. Spike the Squarespace and SMS Gate contracts against a real trial site and the real tablet, then freeze the adapters (D1–D4, B11, B15, B16).
8. Define the SMS policy layer (B13, B14): eligibility function, quiet hours, unknown-sender quarantine, inbound attribution and lane reservation.
9. Close the dashboard-behavior gaps (B22–B27, B30, B32): save semantics, checklist ids, `bay_staff`, bell dot, slot windowing, read-model schemas and SSE resync.
10. Make holiday and closure defaults safe (`notify=false` for generated closures), and fix the factual errors C1, C5, C6, C7, C10 and C11.

### Critical Files for Implementation
- /home/ec2-user/oasis/backend/db/migrations/0001_init.sql
- /home/ec2-user/oasis/backend/src/modules/payments/calc.ts
- /home/ec2-user/oasis/backend/src/modules/scheduling/availability.ts
- /home/ec2-user/oasis/backend/src/modules/integrations/smsgate/
- /home/ec2-user/oasis/backend/src/modules/integrations/squarespace/