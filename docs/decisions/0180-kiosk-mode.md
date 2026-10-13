# 0180 Kiosk mode: the shop tablet unlocked by a shop code, the employee tapped for each change, a fail-closed route list
Status: accepted (2026-10-13, owner plan "Kiosk mode + AI knowledge, training and limits + Square item library sync", section A and
the owner's answers); wave K1a (auth and core) built; attribution (K1b), the report (K2b) and the dashboard (K2a, K2b) follow

The shop's shared tablet should stay open all day without an email login. An 8-digit shop code unlocks it into operations; it stays
unlocked until closing + 2 hours; each car step, payment, text and booking records the employee who tapped their name; the email and
password sign-in is hidden behind typing 0218. Everything is off until a manager turns kiosk mode on (`kiosk.enabled`, default false);
with it off nothing changes. The detailed design is `wt/_reports/k-design-kiosk.md`; where it differs from the approved plan, the plan
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
- **K1b**: writing the employee columns and `staff_events` in every command path (`audit-helper.ts` mapping), the worker on bay
  placement, the Staff view columns for non-crew workers.
- **K2a / K2b**: the dashboard (keypad, kiosk session, picker, Shop floor settings) and the report.

API: `docs/api-spec.md` section 31. Data: `docs/data-model.md` "Kiosk mode". Operations: `docs/runbook.md` section 11.
