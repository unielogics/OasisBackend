# 0180 Kiosk mode: the shop tablet unlocked by an employee's PIN at the shop's network, the employee tapped for each change, a fail-closed route list
Status: accepted (2026-10-13, owner plan "Kiosk mode + AI knowledge, training and limits + Square item library sync", section A and
the owner's answers); wave K1a (auth and core) and K1b (attribution in every command path, and the Team activity report's backend)
built; the dashboard (K2a, K2b) built. **Amended 2026-10-14 by the owner** (section "Amendment" below, package K-PIN): per-employee
PINs at the shop's network replace the shop code and the registered device; K1, K2, K11 and the code parts of K3, K12 and K13 are
superseded there.

The shop's shared tablet should stay open all day without an email login. An 8-digit PIN unlocks it into operations (originally one
shop code; since the amendment each employee's own PIN, only from the shop's internet connection); it stays unlocked until closing + 2
hours; each car step, payment, text and booking records the employee who tapped their name; the email and password sign-in is hidden
behind typing 0218. Originally everything was off until a manager turned kiosk mode on; since the amendment `kiosk.enabled` is on by
default (the keypad is the sign-in page), and nothing unlocks until a Super Admin sets the shop's network and a manager sets PINs. The detailed design is `wt/_reports/k-design-kiosk.md`; where it differs from the approved plan, the plan
wins.

## Decisions

| # | Decision |
|---|---|
| K1 | **Registered devices only.** A manager signs in on the tablet and taps "Make this a kiosk" (`POST /kiosk/devices`): a device row and an opaque 256-bit token in an HttpOnly `__Host-oasis_kdev` cookie (400 days, set again on every unlock), only its sha256 stored. An unregistered browser never has its code checked (`403 KIOSK_DEVICE_UNKNOWN`), so the code is useless away from the tablet. |
| K2 | **The shop code**: exactly 8 digits, never starting with 0218, no repeats, runs, repeating patterns, dates, common codes or one of the last 3. Stored as scrypt over HMAC-SHA256(kiosk key, "<location>:<code>") with the kiosk key = HMAC-SHA256(`SESSION_SECRET`, "oasis-kiosk-code-key:v1") (no new secret; rotating `SESSION_SECRET` means setting a new code). Changing it locks every kiosk. A generated code is shown once. |
| K3 | **Kiosk sessions** are rows like user sessions (sha256 of an HttpOnly `__Host-oasis_ksid` token), valid only with the cookie of their own live device and while kiosk mode is on, with an absolute expiry at the lock time and no idle expiry (owner: no automatic idle lock). Lock, lock all, a code change, revoking the device, kiosk mode off and a new unlock on the device end them. |
| K4 | **Lock time** (`kioskLockTime`, pure): closing + 2 h on an open day; the previous day's window past midnight; 2 hours on a closed day, after closing + 2 h or more than 3 h before opening; capped at 20 h; the 2 hours added to the instant (real hours across daylight saving). Computed once, at unlock. |
| K5 | **`AuthContext.kind: 'kiosk'` with `userId: null`** on purpose: the compiler lists every user-id write, and each records the tapped employee instead. A fake `kiosk:<id>` user id was rejected: every unguarded foreign-key write would fail at run time instead of at compile time. Two self-approval checks compared user ids; `sameUser` never lets a missing id equal another. `SessionAuthContext` narrows back to `userId: string`. |
| K6 | **Resolution order**: a live user session wins; else a kiosk session plus its live device plus `kiosk.enabled`; else unauthenticated. With both, the request is the user's and `X-Oasis-Employee` is ignored. Unlocking signs out a user session that came with it. |
| K7 | **Built-in `KIOSK_PERMISSIONS`**: `sched.view`, `sched.edit`, `jobs.status`, `jobs.checklist`, `cli.view`, `cli.contact`, `pay.collect`, `msg.send`. Not a role, never assignable, disjoint from the Super Admin-only, the money-limited and the report permissions (a unit test). |
| K8 | **A fail-closed route list** (`src/modules/kiosk/allowlist.ts`): many `authenticated` routes (Settings reads, previews) would otherwise be open to any context, which a permission set cannot block. Every route not listed answers a kiosk `403 KIOSK_FORBIDDEN` before any permission check, even by direct URL; the person's own account routes answer `403 KIOSK_SESSION` (and `sessionContext()` throws it too, as defence in depth). The app refuses to start when an entry names no route, a public route or permissions the kiosk lacks; the API contract marks listed operations `x-oasis-kiosk: none\|actor`. |
| K9 | **The acting employee in a header**, `X-Oasis-Employee`, not the body: every body schema is strict, and a field would touch about 35 of them. Bound on unsafe requests after the CSRF check; it must be an active or invited employee of the device's location shown on the kiosk (`422 KIOSK_EMPLOYEE_INVALID`), and is required on `actor` routes (`428 KIOSK_EMPLOYEE_REQUIRED`). The owner chose no PIN when tapping a name: attribution is honest-use, and the report labels kiosk actions "Kiosk". |
| K10 | **Per device**: rate limits, idempotency keys, the ledger and saved-card request keys and the event-stream cap key on `principalKey` / `keyOwnerOf` (`kiosk:<device>`); a user stays their user id so keys stored before kiosk mode still replay. The event stream refuses a kiosk the per-person `notifications` channel. |
| K11 | **Unlock throttle with a lockout**, a deliberate departure from ADR 0008's no-lockout rule: a guess needs physical presence at a registered tablet, the code is the only factor, and nobody can lock the owner out of their email sign-in with it. Per device (persisted): 3 free failures, then 2, 4, 8 ... s up to 5 min before the next code is evaluated; 20 in a row lock the device out until a manager clears it. Per address (in memory): 10 free, up to 120 s. Across devices: more than 60 failures an hour slow everyone by 30 s and raise one alert (audit `kiosk.unlock.alert`, a log line). |
| K12 | **A manager on a kiosk device** (the email/password card behind 0218) gets a short session: 15 minutes idle, 4 hours at most, `sessions.kiosk_device_id`, `GET /me kioskDevice` for the dashboard's bar. |
| K13 | **Audit**: every unlock (success and failure, never the code), lock, lock all, code change, device change and mode switch, with the device in `audit_log.kiosk_device_id`; every kiosk mutation's audit row has `actor_user_id` null, the tapped `actor_employee_id`, roles "Kiosk" and the device. |
| K14 | **Attribution columns** beside the user columns (`activity_log.actor_employee_id`/`kiosk_device_id`, `appointments.created_by_employee_id`, add-ons, photos, payment links) and **`staff_events`** for the Team activity report: added in K1a, written from K1b. |
| K16 | **The worker rule**: a kiosk putting a car in a bay (assign-bay, start, advance to start, the "Start cleaning" alert) makes the tapped employee the car's worker (`appointments.assigned_employee_id`) in the same transaction, with the activity line "Worker: Marco R." and a `worker_set` staff event when it changed. A signed-in person leaves the worker as it was (only the kiosk knows who is physically doing it). Assigning a worker by hand accepts invited employees too (crew on the kiosk may never sign in), of the shop only. The Staff view gives every assigned worker who is not bay staff a column of their own after the crew, so no car disappears. |
| K17 | **Staff events, one place per path**: `recordStaffEvent` (`src/platform/staff-events.ts`) writes a row in the command's transaction whenever the request has an acting employee (kiosk or signed in; system, automation, geofence and AI actions have none). Appointment actions go through `scheduling/audit-helper.ts`, whose action type is a literal union mapped exhaustively to a kind (or to null: cancel, no-show, reopen, deleting a photo, a bay's status), so a new action does not compile until it is mapped; payments through `payments/staff-events.ts` (collect and store credit are a `payment` with the ledger event and amount, then `tip`, `receipt`, `payment_link`); a new client, a text (now audited as `message.staff_send`), a check-in link (now audited), one checklist tick (now audited) and a saved-card charge (when its payment is recorded, in the name of whoever confirmed it, kept on `square_charges.decided_by_employee_id`) record their own. Each event links its audit row (`staff_events.audit_id`, unique). A presigned photo slot is not an event (the photo is, when completed). History: `pnpm staff-events:backfill` rebuilds the events of everything audited before, with the same maps, once (running it again adds nothing). |
| K18 | **The Team activity report** (`GET /reports/employee-activity`, `.../:employeeId/events`): whole business days in the shop's time zone, at most 31; counts per employee and day from `staff_events` (check-ins = arrive plus a drag from booked or confirmed; bays started = assign-bay plus start), checklist tasks from `job_checklist_items` (the tasks done now, for whoever ticked them, on that day: un-ticking takes one back, so ticking one task on and off never adds up), texts from `messages`, payments from the ledger (`pay` and store credit applied, done, a voided one never counted; amounts only with `pay.reports`), bay minutes from the cars the employee was the worker of at completion (`appointments.completed_worker_id`), picked up as cars. Everyone active or invited at the shop is listed; with an employee, every car they touched with each step and who did it; the timeline is paged newest first, its cursor keeping the event's instant to the microsecond (events of one request are microseconds apart). |
| K15 | Managing kiosks needs `team.roles` (no new permission key, so the roles matrix and its design stay unchanged); the activity report needs `team.edit`, its amounts `pay.reports`. |

## Security review notes

- **Physical trade-off.** Anyone at an unlocked tablet sees client files with phone numbers, can text clients and take payments.
  Reduced by: no refunds, voids, adjustments, credits, exports, Settings, team or reports; the lock at closing + 2 h; Lock kiosk; remote
  Lock all and Remove; per-device audit. The runbook advises the tablet's own guided access and screen lock.
- **Device token theft.** HttpOnly, `__Host-`, Secure: page script cannot read it, and only its hash is stored; Settings shows each
  device's last address and browser. Rotating the token on each unlock was deferred (a lost response would brick the tablet); pinning
  unlocks to the shop's network (`kiosk.allowed_networks`) is a later option.
- **Brute force.** 10^8 codes minus about 10^4 starting with 0218 and a few hundred patterns; 20 guesses per device per manager
  intervention, after about 48 minutes of enforced waits: about 2 × 10^-7 per lockout cycle; N stolen device tokens give 20N, and the
  global alert catches spraying.
- **0218 is UI only.** It reveals a form; the credentials, the sign-in throttle and the equalised scrypt work are unchanged.
- **CSRF.** A synchronizer token per kiosk session (the same HMAC construction) plus the Origin check; SameSite=Lax as for users (the
  Square app and links must still bring the cookie back).

## Waves

- **K1a (this package)**: migrations `20261016100000_kiosk`, `…100100_staff_attribution` (columns only), `…100200_staff_events` (table
  and indexes only); Kysely types; the setting; `KIOSK_PERMISSIONS`; `src/modules/kiosk/**` (code rules and hasher, lock time, devices,
  sessions, throttle, staff list, route list with the boot check, every `/kiosk/*` route); the `AuthContext` change with its compile
  fixes; the authorizer, hooks, CSRF, `/auth/csrf`, `KIOSK_SESSION`, rate limits, idempotency, event streams, audit and short admin
  sessions; the report routes as a contract answering `501 NOT_BUILT`.
- **K1b (built)**: the employee columns and `staff_events` in every command path (K17), the worker rule and the Staff view (K16), the
  report's backend (K18, replacing the 501 contract), migration `20261016100300_staff_attribution_links` (`staff_events.audit_id`, who
  confirmed a saved-card charge), the history backfill (`pnpm staff-events:backfill`, run once at rollout). Tests:
  `test/kiosk/attribution.test.ts` (generated from the route list: every `actor` route's audit row, its one staff event and its activity
  lines in the tapped employee's name with the device and no user; the worker rule; the Staff view; the ledger; refunds and voids
  refused; the text's sender; the backfill) and `test/kiosk/report.test.ts`.
- **K2a / K2b**: the dashboard (keypad, kiosk session, picker, Shop floor settings, Team activity).
- **K4 review fixes (2026-10-13)**:
  - *A manager on the tablet* (kiosk:F1, F2): a user session that comes with the cookie of a live kiosk device is tied to that device
    for good (`sessions.kiosk_device_id`, the short 15 min / 4 h timings, the banner), however it was opened: before the tablet was
    registered (the runbook's order), by an invite accepted there (`POST /auth/invite/accept` now passes the device cookie as sign-in
    does), or elsewhere. Lock all, locking or removing a device, and turning kiosk mode on or off also end every user session tied to
    the kiosk devices concerned (`revokeUserSessionsOnKiosks`), the caller's own included (its cookie is cleared). So following the
    runbook (register, then mode on from the tablet) ends on the keypad, never on a 14-day manager session.
  - *The last-3-codes rule* (KK-R1) runs under the location lock, so two changes to the same new code cannot both pass it.
  - *Money an unlocked kiosk changes* (kiosk:F3, tax:H4, tax:M2): a payment link from a kiosk is for the balance only (403
    `PAYMENT_LINK_KIOSK` for a deposit or a typed amount); a link it pastes must be on a host `PAYMENT_LINK_HOSTS` names exactly
    (`=shop.squarespace.com`; the default `squarespace.com` takes any store's subdomain, and Square's shared link hosts never count),
    else 422 `PAYMENT_LINK_KIOSK_URL` (the invoice's stored link needs no paste); a kiosk raises a tip to at most half the bill before the
    tip, never less than $20 (422 `PAY_TIP_KIOSK_LIMIT`); nobody lowers a tip below what the client already paid (409
    `PAY_TIP_BELOW_PAID`: refund instead).
  - *The report* (attr:K4A-2..5, KA-RV1): bay minutes and the cars list follow `appointments.completed_worker_id` (migration
    `20261016100400_completed_worker`, the worker at completion, backfilled from the current worker of completed cars), so a later
    worker change moves nothing; `pickedUp` counts cars (pickup, undo, pickup again is one); store credit applied (`credit_apply`)
    counts in Payments as the timeline shows it; a cursor with an impossible date is 422, not 500.

API: `docs/api-spec.md` section 31. Data: `docs/data-model.md` "Kiosk mode". Operations: `docs/runbook.md` section 11.

## Amendment (2026-10-14, owner): kiosk unlock by per-employee PINs at the shop's network

The owner rejected "a manager signs in on the tablet and registers it". Binding text: the plan's section "AMENDMENT (2026-10-14,
owner)" and its follow-up (shop networks are Super Admin only). Migration `20261017100000_kiosk_pins`; api-spec section 31; runbook
section 11.

| # | Decision |
|---|---|
| A1 | **Per-employee PINs** (`employee_kiosk_pins`), set only by managers (`team.roles`, a signed-in person): typed, or generated and shown once (`PUT /kiosk/staff/:employeeId/pin`, `DELETE` removes it). The K2 rules (8 digits, never 0218…, no repeats, runs, patterns, dates or common PINs), plus **unique in the shop** (a taken PIN gets the neutral "Choose another PIN.": never who, never "in use") and **not one of that employee's last 3** (the current one and two in `employee_kiosk_pin_history`). Audited without the PIN (`kiosk.pin.set`, `kiosk.pin.remove`). Deactivating an employee removes their PIN (a trigger on `employees.status`, so every path does it). A PIN change locks nothing (the tablet is open for everyone; locking it would punish the others). |
| A2 | **The PIN lookup is a keyed HMAC, not scrypt**: hex HMAC-SHA256(key, "<location>:<pin>") with key = HMAC-SHA256(`SESSION_SECRET`, "oasis-kiosk-pin-key:v1"). Deterministic on purpose: a typed PIN finds its employee by an index, and uniqueness is a unique index (a race of two managers giving the same PIN is one 200 and one 422). A database copy alone cannot be brute-forced (it needs `SESSION_SECRET`); with both, 10^8 HMACs are cheap, an accepted trade-off since the same secret signs every session. Rotating `SESSION_SECRET` makes every PIN stop working (managers set new ones). |
| A3 | **"At the shop" = the shop's internet connection** (`kiosk_networks`): an IPv4 address exactly (/32), an IPv6 address by its /64 (one line's prefix; a device's own address inside it changes for privacy). The caller's address is Fastify's `req.ip` and nothing else, through the existing `TRUST_PROXY` (verified on production 2026-10-14 by the orchestrator: `TRUST_PROXY=true` = exactly one trusted hop; nginx (`deploy/nginx/oasis-proxy.conf.template`) OVERWRITES `X-Forwarded-For` and `X-Real-IP` with `$remote_addr`; the API listens on 127.0.0.1 only; DNS points straight at the EC2 address, no CDN or load balancer; nginx listens on IPv4 and IPv6, so `req.ip` is the client's public address). A forwarding header is never read directly; an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) counts as IPv4 (`kiosk/network.ts`). |
| A4 | **Shop networks are Super Admin only** (owner follow-up): `POST /kiosk/networks` and `DELETE /kiosk/networks/:id` need `team.roles` AND `requireSuper` (people/guards.ts): the same `isSuper` flag every SUPER_ONLY rule reads, true only when the real person holds the locked Super Admin role and is not viewing as a lesser role, so view-as can only narrow (a Super Admin viewing as Management gets 403 SUPER_ONLY; a manager cannot view as anyone). Managers see the networks and the refused list and keep PINs, browsers and lockouts. |
| A5 | **"This is the shop's network"** is done signed in on ANY device on the shop Wi-Fi (phone, laptop, or the tablet itself via 0218): every device behind the shop's router shares its public address (production has no AAAA record, so every client arrives over IPv4 today). `GET /kiosk` shows `yourAddress` and `yourAddressIsShop`; `POST /kiosk/networks {confirmAddress}` adds THE CALLER's address and only when it still equals the one the screen showed (409 `KIOSK_ADDRESS_CHANGED` otherwise: a phone that flipped between Wi-Fi and mobile data meanwhile cannot add the wrong address). The screen tells people to use the shop Wi-Fi, not mobile data. |
| A6 | **Refused tries are listed for approval** (`kiosk_refused_networks`): a PIN from an address in no shop network is refused with 403 `KIOSK_NOT_AT_SHOP` (with `meta.networkSet`) before any PIN work, and its address is listed with first/last seen, a count and `fromKnownBrowser` (the try carried the device cookie of a browser that unlocked at the shop before, with its name: the strong sign that the provider changed the shop's address, versus an unknown browser). `POST /kiosk/networks {address}` approves one of THOSE recorded addresses only (404 `KIOSK_REFUSED_UNKNOWN` otherwise), Super Admin, from anywhere. Writes are rate-limited per address (at most once a minute, the tries in between counted in memory and added with the next write); the table keeps 30 days and at most 50 rows a location, unknown browsers' rows pruned first, so a flood of addresses (an IPv6 /48 has 65,536 /64s) can neither grow it nor push out the tablet's entry; refused tries are never audit rows. |
| A7 | **Registration goes away**: no "Make this a kiosk" (`POST /kiosk/devices` removed) and no registered-device requirement. A browser gets its device cookie (`__Host-oasis_kdev`, 400 days) at its first successful unlock at the shop: a `kiosk_devices` row named "Shop browser N · Safari on iPad" (managers rename, Lock, Remove it; Lock all stays). A removed browser's cookie never works again; a PIN typed on it later, at the shop, makes it a new shop browser (anyone at the shop with a PIN could unlock anyway). The short admin session (K12) now applies to a browser holding a live device cookie, i.e. one that unlocked at the shop. |
| A8 | **Unlock** (`POST /kiosk/unlock {pin}`): kiosk mode off → 409 `KIOSK_OFF`; not at the shop → 403 `KIOSK_NOT_AT_SHOP` (recorded, never evaluated); then the throttle; then the PIN's lookup must name an active or invited employee of the shop shown on the kiosk (anything else is the same 401 `KIOSK_PIN_WRONG`, so a wrong PIN never reveals whether someone has it). Success opens the kiosk for everyone with the K4 lock time, `kiosk_sessions.opened_by_employee_id` / `opened_by_name` ("Opened by Marco R.", in `KioskMe.openedBy` and the browser list), an audit `kiosk.unlock` in the opener's name with the device (`after.openedBy`) and a `kiosk_unlock` staff event on their timeline (the backfill rebuilds it from that audit row). The name popup stays on every car step. Every other kiosk rule stays (fail-closed route list, acting employee header, `KIOSK_SESSION`, CSRF, SSE, per-device rate limits and keys). |
| A9 | **Throttle per address and per browser** (replaces K11's per-device / per-address split): per shop address (persisted on its `kiosk_networks` row, shared by every browser at the shop): 5 free wrong PINs, then 2, 4, 8 … s up to 5 min before the next PIN is evaluated, 30 in a row lock the address out until a manager clears it (`POST /kiosk/networks/:id/clear-lockout`, `team.roles`); per browser (its device cookie, when it has one): 3 free, the same waits, 20 lock that browser out (`POST /kiosk/devices/:id/clear-lockout`). A success resets both. The global part stays (more than 60 wrong PINs an hour slow everyone by 30 s and raise one `kiosk.unlock.alert`). An unlock holds the address's row lock, so guesses from the shop are serialised; Lock all takes the same rows first. |
| A10 | **`GET /kiosk/status`** (public) answers `{enabled, networkSet, atShop, unlocked, lockedOut, retryAfterSec}` (no personal data, no device name any more): the keypad says "PINs work only at the shop" up front, or "A Super Admin must set the shop network first (Settings → Kiosk)" before any network exists. |
| A11 | **Kiosk mode on by default**: the setting's default is true, and the migration turns on the row the server wrote at boot with the old default (value false, version 1, never changed or audited); a value somebody set stays. With no network and no PIN the keypad only explains; 0218 still reveals the email sign-in and admin features still need it. Turning it off (rollback) brings the email sign-in page back. |
| A12 | **The shop code goes away**: `PUT /kiosk/code` removed; `kiosk_codes` dropped and `kiosk_sessions.code_id` with it (every code-era session deleted; production never had a code set, so nothing is lost); the `code_changed` revoke reason is gone. |

Security notes (amendment):

- **What a PIN needs now.** The shop's public address and a valid PIN of a listed employee: someone on the shop Wi-Fi (a customer
  in the waiting area, if the Wi-Fi is shared) can try PINs from any browser. Brute force is bounded by the per-address lockout (30
  guesses per manager intervention, after the waits) and the global alert; with N employees holding PINs, a guess succeeds with
  probability N/10^8. The runbook advises a separate guest Wi-Fi.
- **Address changes and sharing.** 5G home internet and Starlink-style connections change their public address often and share it
  with other customers (carrier-grade NAT): anyone behind the same shared address would count as "at the shop". The runbook says so;
  the refused list makes a changed address one tap for the Super Admin.
- **No forwarding header is trusted** beyond the one hop `TRUST_PROXY` names; a test proves a client-typed left-most
  `X-Forwarded-For` entry and, without `TRUST_PROXY`, any forwarding header are ignored.
- **A refused try costs no PIN work** and writes at most one row per address a minute into a capped table.

Tests: `test/kiosk/kiosk.test.ts` (on by default and the migration rule; networks: Super Admin only, manager 403 SUPER_ONLY, view-as
cannot widen, confirmAddress 409, IPv4 exact, IPv6 /64, IPv4-mapped, approving a refused address, fromKnownBrowser, the refused list's
write limit, cap and 30 days; the proxy chain with and without `TRUST_PROXY`; PIN rules, uniqueness, last 3, generated once, removal,
deactivation, concurrent same PIN; unlock outcomes, throttle and lockout per address and per browser, first-unlock auto-registration,
opened_by in sessions, audit and staff events; the code and registration routes gone), `test/kiosk/pin.test.ts`,
`test/kiosk/network.test.ts`, `test/kiosk/throttle.test.ts`, the generated authz matrices, and every earlier kiosk test adapted (the
harness's `kioskSetup` now adds a shop network, sets a PIN and unlocks a fresh browser).
