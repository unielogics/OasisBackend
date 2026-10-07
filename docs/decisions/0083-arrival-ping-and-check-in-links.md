# 0083 Arrival ping, geofence check-in and the customer link token

Status: accepted (2026-10-07). Closes gap 2 of the b6 list. Implements backend design 4.9 ("Arrival and geofence ingest") and 5.3 for
the part the customer app will call; the app itself comes later. Migration `20261006300000_arrival_ping.sql`.

**Who may do what**

| Action | Who | Route |
|---|---|---|
| Mark a booked or confirmed job arrived (the desk) | staff with `jobs.status` or `sched.edit` | `POST /appointments/:id/arrive` (unchanged) |
| Issue the customer's check-in link | staff with `sched.edit` | `POST /appointments/:id/arrival-link` (201) |
| Report a position, ETA and "I'm here" | the customer's phone, holding the link token; no session | `POST /arrivals/ping` (public, token-authenticated) |
| Set the shop coordinates (the geofence centre) | `set.hours` | `PUT /settings/location` (`GET` is any signed-in user) |
| Behave as a ping from the door or from N minutes away | `jobs.status`, only with `ALLOW_DEV_ENDPOINTS` | `POST /dev/appointments/:id/simulate-arrival` |

**The token.** `oa_` plus 32 random bytes in base64url (256 bits). Only its SHA-256 is stored, in the existing
`appointments.arrival_token_hash` (unique index); the plain token exists only in the issue response. Issuing again **rotates** it, so
an old link stops working at once. It expires two hours after the booked end (`arrival_token_expires_at`) and is dead for a canceled
or no-show job. Unknown or closed: 401 `ARRIVAL_LINK_INVALID`; past expiry: 410 `ARRIVAL_LINK_EXPIRED`. The issue response also
carries `path` (`/a/<token>`) and `url` (`PUBLIC_API_URL` + path); the customer app will serve that page and post the token to the
ping route. Nothing sends the link yet: a later template (confirmation SMS) or the app's own deep link does. A page on another
origin must have that origin in `ALLOWED_ORIGINS` (the origin check applies to every unsafe request that carries an Origin).

**The ping** `{token, lat, lng, accuracyM?, etaMinutes?, declared?, pingId?}`. The server computes the haversine distance to
`locations.lat/lng` (409 `ARRIVAL_NOT_CONFIGURED` without them) and reads the radius and toggles from the arrival settings.
* `on = false`: answers `disabled`, stores nothing.
* **Inside the radius with a fix at least as accurate as the radius** (a vaguer fix proves nothing and answers `inconclusive`):
  auto check-in on: the ordinary `arrive` command runs with source `geofence` as an automation actor (sets `arrived_at` and
  `geo_checked_in_at`, clears the ETA, queues the welcome SMS when that toggle is on, logs "Auto check-in · geofence"), answer
  `checked_in`; auto off: `geo_checked_in_at` is set and alert "Checked in at the lot" (`confirm_checkin`) asks staff to press
  Mark arrived, answer `confirm_needed`. SSE `arrival.checked_in {appointmentId, auto, distanceM}` on `ops`.
* **Outside**: the ETA is the phone's own (0..600 min) or the distance at 25 km/h rounded up; stored in `eta_minutes`/`eta_at`
  (it feeds alerts "Arriving soon/in N min"), SSE `arrival.eta {appointmentId, etaMinutes, distanceM, crossed}`, and **one** crew
  bell notification (kind `arrival`, on-shift people, only with "Alert the crew") when the ETA first reaches the prep time. A job
  that has already arrived answers `already_arrived` and changes nothing (no second welcome text, no second event).
* **Idempotency and abuse.** A repeated `pingId` returns the stored answer (`arrival_pings.reply`); accepted pings are at least 5 s apart
  per appointment (429 `ARRIVAL_PING_TOO_FAST` with `Retry-After`) and the route is limited to 60 per minute per address
  (429 `RATE_LIMITED`). The token, not an appointment id in the body, selects the appointment, so a ping cannot be aimed at another job.
* **Not possible from a link page**: background geofencing; the page reports while it is open. True background geofencing needs the
  customer app (design 4.9).

Tests: `test/scheduling-gaps/arrival-ping.test.ts` (16, real Postgres, real app).
