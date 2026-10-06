# SMS Gate integration

Oasis sends and receives customer SMS through [SMS Gate](https://github.com/capcom6/android-sms-gateway) (`capcom6/android-sms-gateway`)
running on a cellular Android tablet that the backend reaches over Tailscale. Squarespace stays the card processor; SMS is the
only customer channel (ADR 0004). This page records what was verified against the app, what is still assumed, how to set up the
tablet, and how the code is laid out.

Verified on 2026-10-06 against app release **v1.77.1** (2026-10-01) and its OpenAPI document (version 1.77.2). Nothing here was
checked against a physical device yet: there is none. Everything in "Assumptions to verify on the tablet" must be ticked off on
the real hardware before the adapter is considered frozen.

## 1. Verified contract

### Sources

| Short name | Source |
|---|---|
| OpenAPI | `https://capcom6.github.io/android-sms-gateway/swagger.json` (SMSGate API 1.77.2) |
| Webhooks doc | `https://docs.sms-gate.app/features/webhooks/` |
| App source | `https://github.com/capcom6/android-sms-gateway`, `app/src/main/java/me/capcom/smsgateway/modules/...` (`localserver/WebService.kt`, `localserver/routes/{Messages,Webhooks}Routes.kt`, `localserver/domain/messages/PostMessageRequest.kt`, `webhooks/WebHooksService.kt`, `webhooks/plugins/PayloadSingingPlugin.kt`, `webhooks/workers/*`, `webhooks/WebhooksSettings.kt`, `webhooks/payload/*`, `health/*`, `messages/MessagesSettings.kt`) |
| README | repository `README.md` ("Local Server", "Webhooks") |
| AOSP | `android.googlesource.com/platform/frameworks/opt/telephony`, `SmsUsageMonitor.java` (tags android-4.4_r1, android-10.0.0_r1, android-14.0.0_r1 and main) |
| Tailscale | `tailscale.com/kb/1242/tailscale-serve`, `tailscale.com/kb/1028/key-expiry` |

### Local server

- Started from the app ("Local Server" switch, then the "Offline" button). Default port **8080** (README; the port is a setting).
  Credentials for Basic auth are shown in the app. Interactive docs are served at `/docs` on the device.
- Both route families are served: `/message` and `/messages`, `/webhook` and `/webhooks`, `/device` and `/devices` (WebService.kt).
  The README examples use the singular form, the OpenAPI document the plural. The adapter defaults to `/messages` and the path is
  configurable (`SMSGATE_API_PATH`).
- Auth: HTTP Basic (or a JWT bearer from `/auth/token`). `GET /health` needs no auth. All other routes answer 401 without it.
- Errors: the app returns `{"message": "..."}`. `IllegalArgumentException` and bad requests become 400, a missing resource 404,
  anything else 500.

### Sending: `POST /messages`

Body fields (PostMessageRequest.kt, OpenAPI `smsgateway.Message`):

| Field | Notes |
|---|---|
| `id` | Optional, generated (nanoid) when absent. OpenAPI says max length 36. **We always send our message id.** |
| `textMessage: {text}` | Current form. `message` (string) is the deprecated form. Exactly one of `textMessage`, `message`, `dataMessage`, `mmsMessage` is allowed. |
| `phoneNumbers` | 1 to 100 entries, **must be unique** (400 otherwise). Oasis sends one recipient per message. |
| `simNumber` | 1 to 3, SIM slot, default SIM when absent. |
| `withDeliveryReport` | Defaults to true. |
| `ttl` (seconds, min 5) or `validUntil` (date) | Mutually exclusive (400 `fields conflict`). A message already expired is refused. |
| `priority` | A byte, default 0. **Values of 100 and above bypass the device's own limits and delays**, so the adapter's default map (`P0 50, P1 0, P2 0, P3 -50`) stays below that. |
| `scheduleAt`, `deviceId`, `isEncrypted` | Not used. |
| query `skipPhoneValidation` | Not used. |

Responses: **202** with the message document and a `Location` header, **400** validation, **401**, **409 "Message with the same ID
already exists"** (OpenAPI and MessagesRoutes.kt: `ConflictException`), **503** "Queue limits exceeded; ensure device is online"
(OpenAPI).

Message document (`GetMessageResponse`): `id`, `deviceId`, `state`, `recipients[] {phoneNumber, state, error?}`, `states {state: time}`,
`isHashed`, `isEncrypted`, `createdAt` (added in 1.77.1).

States: `Pending`, `Cancelling`, `Cancelled`, `Processed`, `Sent`, `Delivered`, `Failed`. The port has five, so the adapter maps
`Cancelling` to `Pending` and `Cancelled` to `Failed` with reason `cancelled`.

### Looking a message up: `GET /messages/{id}`

200 with the document, **404** when the id is unknown (`messagesService.getMessage(id) ?: NotFound`). The OpenAPI document does not
list the 404; the source does. `DELETE /messages/{id}` cancels a `Pending` message (400 otherwise, 404 unknown).

### Duplicate-submit behaviour and the idempotency rule

Because the device answers 409 to a repeated id, passing our `messages.id` as the SMS Gate `id` makes a resend harmless. The adapter
still never relies on that alone. On a timeout, a dropped connection or a 5xx it calls `GET /messages/{id}` **first**:

- the device has it: report its state, do not POST again;
- 404: the device never saw it, so one re-POST is safe (`resendAttempts`, default 1);
- the status check itself fails: the outcome is unknown, so raise a retryable error and send nothing more. The dispatcher backs off
  and its next attempt starts with the same POST, which is answered 409 if the first one did land.

A 409 is resolved the same way: look the id up and return its state; never POST again.

A retry after the device itself reported a failure cannot reuse the id (the device would answer 409), so it gets a fresh id:
the UUID without hyphens plus `r1`, `r2`, ... (34 characters, within the 36 limit).

### Health: `GET /health`

No auth. Body `{status: "pass"|"warn"|"fail", version, releaseId, checks}`. Checks seen in the source: `messages:*`,
`connection:*`, `battery:level` (percent; warn below 25, fail below 10) and `battery:charging` (flags: 2 AC, 4 USB, plus 1 when
actually charging). **A `fail` status is returned as HTTP 500 with the body**, `warn` as 200. The adapter reads the body either way.

### Webhooks

Registry (WebhooksRoutes.kt, WebHooksService.kt): `GET /webhooks`, `POST /webhooks` `{id, url, event, deviceId?}` (201),
`DELETE /webhooks/{id}` (204). **One event per registration. POSTing an existing id replaces it**, so registration with fixed ids is
idempotent. The URL must be `https://`, or `http://127.0.0.1`; plain `http://` is accepted only by the app's "insecure" build
flavour. Local-server and cloud-server webhook sets are independent.

Events (OpenAPI `WebhookEvent`): `sms:received`, `sms:data-received`, `sms:sent`, `sms:delivered`, `sms:failed`, `sms:cancelled`,
`system:ping`, `mms:received`, `mms:downloaded`, `app:started`, and the batch forms `sms:batch:received`, `sms:batch:data-received`,
`mms:batch:received`, `mms:batch:downloaded`. Oasis registers seven: `sms:received`, `sms:sent`, `sms:delivered`, `sms:failed`,
`sms:cancelled`, `system:ping`, `app:started`, with ids `oasis-sms-received`, `oasis-sms-sent`, ... (`oasis-` + event with `:`
turned into `-`). It removes stale `oasis-*` registrations and never touches ids it does not own.

Envelope (`WebHookEventDTO`): `{"id": "<nanoid>", "webhookId": "<registration id>", "event": "...", "deviceId": "...", "payload": {...}}`.
The envelope `id` is generated once per delivery and stored with the queued payload, so **every retry of a delivery carries the same
`id`**: that is the dedupe key. The same message can still produce several envelopes (`sms:delivered` fires once per part of a
multipart message), so handlers must also be idempotent per state.

Payloads (`SmsEventPayload.kt`, webhooks doc):

| Event | Payload fields |
|---|---|
| `sms:received` | `messageId, sender, recipient, simNumber, phoneNumber (deprecated alias of sender), message, receivedAt` |
| `sms:sent` | `messageId, sender, recipient, simNumber, phoneNumber, partsCount, sentAt` |
| `sms:delivered` | `messageId, sender, recipient, simNumber, phoneNumber, deliveredAt` |
| `sms:failed` | `messageId, sender, recipient, simNumber, phoneNumber, failedAt, reason` |
| `sms:cancelled` | `messageId, sender, recipient, simNumber, phoneNumber, cancelledAt` |
| `system:ping` | the health document (`status, version, releaseId, checks`) |
| `app:started` | `simCards: [{slotIndex, simNumber, phoneNumber, carrierName, iccid}]` |

Timestamps are ISO-8601 with an offset (`2026-06-13T12:00:02.000-04:00`). For outbound events `messageId` is **our id** (or the
retry id described above).

### Signature (exact)

Headers `X-Signature` and `X-Timestamp` (PayloadSingingPlugin.kt):

```
X-Timestamp = floor(System.currentTimeMillis() / 1000)             decimal Unix seconds
message     = <raw JSON request body> + <X-Timestamp text>          plain concatenation, UTF-8
X-Signature = lowercase hex( HMAC-SHA256( key = signing key bytes, message ) )
```

The body signed is the exact text posted, so the handler must verify against the raw bytes, never a re-serialised object. Every
retry is signed afresh with the current time over the identical body. The key is the app's "Signing key" (Settings, Webhooks,
also `PATCH /settings` `{"webhooks": {"signing_key": "..."}}`). **If none is set the app generates a random 8-character key on
first use**, so set a strong one explicitly.

`signWebhook` and `verifySignature` (`src/integrations/smsgate/signature.ts`) implement this. Fixtures carry signatures computed
independently with Python's `hmac`.

### Delivery and retry policy

- The receiver must answer 2xx within 30 s. The app uses connect 5 s, socket 5 s, request 30 s timeouts.
- Any non-2xx or network error is retried with exponential backoff. The docs say 14 retries from 10 s, about two days; the
  source (WebhooksSettings.kt `retryCount` default 15, WebhookQueueRepository `baseDelay` 5 s doubling) differs slightly. Treat
  "about two days" as the bound: the default timestamp tolerance is therefore **24 h** (`SMSGATE_WEBHOOK_TOLERANCE_SECONDS`) and
  signature is checked before the timestamp. A tolerance below the retry window drops late retries of events that matter.
- Webhook delivery needs network (`internet_required` defaults to true).

### Device-side settings that matter (`GET/PATCH /settings`, MessagesSettings.kt)

- `messages.processing_order`: **default is LIFO**. Set `FIFO` so a backlog drains oldest first.
- `messages.limit_period` (`Disabled|PerMinute|Per30Minutes|PerHour|PerDay`) and `limit_value`: an optional app-side cap, a useful
  second line behind the dispatcher budget. Messages over it wait as `Pending` rather than triggering Android's dialog.
- `messages.send_interval_min/max` (seconds): random delay between sends. `messages.sim_selection_mode`.
- `ping.interval_seconds`: enables `system:ping`. **Unset means no pings**, and Oasis would then rely on its own polling only.
- `webhooks.signing_key`, `webhooks.retry_count`, `webhooks.internet_required`.

### Android's own SMS rate limit

AOSP `SmsUsageMonitor` keeps a list of send timestamps per calling package and refuses a send when
`sent.size() + parts > max` inside the window, then shows a confirmation prompt that blocks the app until a person taps it. **A
multipart message counts once per part.** The stock defaults in every release checked (4.4, 10, 14, main) are
`DEFAULT_SMS_MAX_COUNT = 30` and `DEFAULT_SMS_CHECK_PERIOD = 60000` ms, that is **30 messages per minute**, overridable through
`Settings.Global` `sms_outgoing_check_max_count` and `sms_outgoing_check_interval_ms` (settable over `adb shell settings put global`).
The plan's "about 30 per 30 minutes" is how some vendors and gateway vendors describe it (Telerivet's documentation, for one) and
it is stricter than AOSP, so it is a safe default but it is not what stock Android does. Which applies on the shop's tablet is
**unverified** (see the checklist). The dispatcher therefore defaults to **30 segments per 30-minute sliding window** and counts
segments, not messages. After the limit has been measured on the tablet, raise it with `SMSGATE_MAX_PER_WINDOW` and
`SMSGATE_WINDOW_MINUTES`. Carrier anti-spam heuristics on a consumer SIM, not Android, are the likelier ceiling for volume.

## 2. Assumptions to verify on the real tablet

Tick each in `docs/integrations/smsgate.md` when done, and replace the fixtures in `test/fixtures/smsgate/` with captures
(the contract suite, `test/integrations/smsgate/contract.test.ts`, runs unchanged against them).

| # | Assumption | How to verify | If wrong |
|---|---|---|---|
| 1 | The installed build serves `/messages` (OpenAPI) as well as `/message` | `curl -u u:p http://100.x.y.z:8080/messages` | set `SMSGATE_API_PATH=/message` |
| 2 | A repeated `id` answers 409 and does not send twice | POST the same id twice, check the phone and `GET /messages` | rely on the status-first rule alone (already the primary protection); if `id` is ignored, dedupe on (to, body, window) against `GET /messages` |
| 3 | `GET /messages/{unknown}` is 404 | curl an unknown id | the adapter needs the not-found signal; add the observed status to `status()` |
| 4 | `textMessage` is accepted | send once | `SMSGATE_LEGACY_MESSAGE_FIELD=true` |
| 5 | Ids up to 36 characters including our UUIDs and `...r1` retry ids are accepted | send a UUID and a 34-char id | shorten ids in `retryProviderId` |
| 6 | The signature is exactly `hex(HMAC-SHA256(key, rawBody + X-Timestamp))` for a real delivery, including bodies with emoji and quotes | capture a delivery (`webhook.site` or the logged raw body), add it as a fixture, verify | the verifier is a single function; adjust `signWebhook` |
| 7 | HTTPS to `https://<host>.<tailnet>.ts.net/...` is accepted by the app (valid Tailscale-issued cert) and the tablet resolves the name (MagicDNS) | register a webhook and send a text to the tablet | check MagicDNS and HTTPS certificates in the Tailscale admin; fall back to a public relay only if unavoidable |
| 8 | `tailscale serve --set-path` strips the mount path, so the target needs the full path | `tailscale serve status`, then `curl` the URL from the tablet | adjust the target URL |
| 9 | Real retry count and spacing after a 5xx | return 500 to a delivery and note the attempts | tune `SMSGATE_WEBHOOK_TOLERANCE_SECONDS` |
| 10 | `system:ping` payload is the health document and arrives at the configured interval | set `ping.interval_seconds` to 60 and capture | health also polls `GET /health` every minute, so pings are optional |
| 11 | Android's SMS limit on this tablet (30 per minute stock, or 30 per 30 minutes) and what the prompt looks like | send 31 short texts to a test number inside a minute, then inside 30 minutes | set `SMSGATE_MAX_PER_WINDOW` and `SMSGATE_WINDOW_MINUTES` |
| 12 | `priority` below 100 does not change delivery order or bypass limits | send a P3 then a P0 with the device paused | set the priority map to all zeros |
| 13 | The carrier returns delivery reports (many MVNOs do not) | send to a phone, watch for `sms:delivered` | messages stay `Sent`; reconciliation stops asking after 6 h and Oasis treats `sent` as final |
| 14 | `sms:delivered` fires once per part of a multipart message | send a 3-part message | handler is already idempotent per state |
| 15 | The inbound `sender` format (bare digits, with plus, country code) | text the tablet from a phone | `normalizeE164` handles bare US digits and plus forms; extend for other formats |
| 16 | Inbound texts from RCS-capable phones reach SMS Gate. If the tablet's default Messages app has chat features/RCS on, those messages may bypass SMS | text from an iPhone and a Pixel; turn off "Chat features" in the Messages app if one never arrives | disable RCS on the tablet |
| 17 | The app survives sleep, an OEM battery manager and a reboot (starts on boot, local server comes back, emits `app:started`) | overnight idle, then a reboot | per-vendor "autostart" and "unrestricted battery" settings |
| 18 | The dual-SIM `simNumber` mapping | send with `simNumber` 1 and 2 | set `SMSGATE_SIM_NUMBER` |
| 19 | `PATCH /settings` accepts `webhooks.signing_key` (for `SMSGATE_SYNC_SIGNING_KEY=true`) | one call | set the key by hand in the app |
| 20 | The local server answers on the tailnet interface (not only Wi-Fi) | `curl http://<tablet tailscale ip>:8080/health` from the backend host | check Tailscale ACL and that the tablet's Tailscale app is connected |

## 3. Tablet and Tailscale runbook

### Hardware preconditions (hard)

1. **A cellular-capable tablet or phone with an active SIM that can send and receive SMS.** A Wi-Fi-only tablet cannot send SMS.
   Many data-only tablet plans cannot send SMS either; confirm the plan includes it. Use a dedicated number the shop publishes.
2. Unlocked bootloader is not needed. Android 8 or later. Keep it plugged in.
3. Decide how to handle the carrier: a consumer SIM sending business volume risks filtering. Keep volume low, honour STOP, and keep
   `SmsProvider` swappable for a business provider later.

### On the tablet

1. Install **SMS Gate** (Play Store, F-Droid or the GitHub release APK). Grant SMS (send and receive), phone state, notifications.
2. In the app: Local Server on (port 8080), note the username and password, tap the button to start it.
3. Settings, Webhooks: set a strong **signing key** (the same value as `SMSGATE_WEBHOOK_SECRET`). Leave "internet required" on.
4. Settings, Messages: processing order **FIFO**; optionally a limit equal to the dispatcher budget; send interval 3 to 6 s.
5. Settings, Ping: interval **60 s**.
6. **Battery optimisation off** for SMS Gate and for Tailscale (set both to "Unrestricted"); disable adaptive battery and
   "put unused apps to sleep"; allow autostart if the vendor has such a switch; Wi-Fi "stay connected during sleep"; screen timeout
   as short as you like (the app runs a foreground service).
7. Messages app: turn **RCS/chat features off** on the shop SIM so inbound arrives as SMS.
8. Install **Tailscale for Android**, log in to the same tailnet, set **Always-on VPN** (do not enable "block connections without
   VPN": the cellular link must keep working). Confirm the tablet shows a stable `100.x.y.z` address.

### In the Tailscale admin console (once)

1. Enable **MagicDNS** and **HTTPS Certificates** (DNS page).
2. Tag the nodes: `tag:oasis-server` (backend host), `tag:oasis-tablet` (tablet). ACLs:
   - `tag:oasis-server` to `tag:oasis-tablet:8080` (backend to SMS Gate local server)
   - `tag:oasis-tablet` to `tag:oasis-server:443` (SMS Gate webhooks to the backend)
3. **Disable key expiry on both nodes** (Machines, node menu, "Disable key expiry"). The default is 180 days and an expired key
   silently disconnects the device (kb/1028).

### On the backend host

```bash
# the API listens for hooks only on a dedicated loopback port (no path exposure to the tailnet beyond /hooks/smsgate)
sudo tailscale serve --bg --https=443 --set-path /hooks/smsgate http://127.0.0.1:3002/hooks/smsgate
tailscale serve status        # https://oasis-api.<tailnet>.ts.net/hooks/smsgate  ->  http://127.0.0.1:3002/hooks/smsgate
```

`tailscale serve` strips the mount path before proxying, so the target carries the full path again. Flag spellings change between
Tailscale versions, so check `tailscale serve --help`. Notes: the host name appears in public certificate-transparency logs; run
the host with `--accept-dns=false` to avoid resolver changes on EC2; coexistence with nginx on 443 is unverified, so keep `serve` on
the tailnet address only.

Registered webhook URL: `https://oasis-api.<tailnet>.ts.net/hooks/smsgate/<deviceKey>`. Outbound traffic needs no certificate:
`SMSGATE_DEVICE_URL=http://100.x.y.z:8080` (WireGuard encrypts the hop, Basic auth rides inside).

### Bring-up and smoke test

1. From the backend host: `curl http://100.x.y.z:8080/health` (200 `pass`).
2. `pnpm sim:smsgate` against a local backend first, then switch `SMS_PROVIDER=smsgate`.
3. Run `registerWebhooks(<url>, SMSGATE_WEBHOOK_SECRET)` (boot, then hourly, and again on every `app:started`). Check
   `GET /webhooks` on the device lists seven `oasis-*` registrations.
4. One text out to a test phone to an allow-listed number (`SMS_ALLOWLIST`), see `sent` and `delivered` webhooks.
5. One text in (`C`, then `STOP`, then `START`, then `HELP`); confirm opt-out and replies.
6. Turn the tablet's mobile data/VPN off for two minutes: expect `degraded` then `offline`, the queue holds, and on return the
   backlog flushes, with expired (`welcome` after 15 min) messages dropped rather than sent late.

### Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Every webhook arrives with `bad_signature` | signing key differs between app and `SMSGATE_WEBHOOK_SECRET`, or the body was re-serialised before verifying | verify the raw body; re-set the key |
| Nothing arrives from the tablet, polls fine | webhook URL not HTTPS-valid, MagicDNS off on the tablet, or `tailscale serve` path mismatch | `tailscale serve status`, curl the URL from the tablet browser |
| Device `offline` after months | Tailscale node key expired | disable key expiry; re-authenticate |
| Sends stall silently | Android SMS limit dialog on the tablet | lower the budget, wake the tablet, raise the OS limit with adb |
| `app:started` alerts without a reboot | OEM killed the app | unrestricted battery, autostart; webhooks are re-registered automatically |
| Messages stay `accepted` | webhooks lost or carrier gives no receipts | reconciliation resolves them via `GET /messages/{id}` |
| Inbound from some phones never arrives | RCS on the tablet's Messages app | turn chat features off |

## 4. Environment variables

Existing in `src/config/env.ts`: `SMS_PROVIDER` (`sim|smsgate`), `SMSGATE_DEVICE_URL`, `SMSGATE_USERNAME`, `SMSGATE_PASSWORD`,
`SMSGATE_WEBHOOK_SECRET`, `SMSGATE_MAX_PER_WINDOW` (30), `SMSGATE_WINDOW_MINUTES` (30), `SMS_ALLOWLIST`, `BUSINESS_TZ`, `NODE_ENV`,
`RESCHEDULE_LINK_ENABLED`.

Read by this subsystem and **not yet in the env schema** (all optional; the integrator should add them to `src/config/env.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `SMSGATE_API_PATH` | `/messages` | send/lookup path (`/message` for old builds) |
| `SMSGATE_TIMEOUT_MS` | 10000 | per-request timeout |
| `SMSGATE_WEBHOOK_TOLERANCE_SECONDS` | 86400 | accepted `X-Timestamp` skew |
| `SMSGATE_RESEND_ATTEMPTS` | 1 | re-POSTs after an ambiguous failure where the device says not-found (0 to 3) |
| `SMSGATE_SIM_NUMBER` | none | default SIM (1 to 3) |
| `SMSGATE_LEGACY_MESSAGE_FIELD` | false | send the deprecated `message` field |
| `SMSGATE_SYNC_SIGNING_KEY` | false | push the key to the device with `PATCH /settings` while registering webhooks |
| `SMSGATE_ALLOW_INSECURE_WEBHOOK_URL` | false | accept `http://` webhook targets (insecure app build only) |
| `SMSGATE_RESERVED_P0` | 6 | segments of each window reserved for lane 0 |
| `SMSGATE_SAFETY_MARGIN` | 0 | segments subtracted from the window cap |
| `SMSGATE_MIN_INTERVAL_MS` | 3000 | minimum gap between two sends |
| `SMSGATE_MAX_SEGMENTS` | 8 | longest accepted message in segments |
| `SMSGATE_HEARTBEAT_STALE_SECONDS` | 600 | silence after which the device is `offline` |
| `SMSGATE_ONLINE_WITHIN_SECONDS` | 180 | silence after which `online` becomes `degraded` |
| `SMS_QUIET_HOURS` | `21:00-08:00` | local-time window (`BUSINESS_TZ`) that holds non-transactional classes; `off` disables |
| `SIM_PORT`, `SIM_HOST`, `SIM_USERNAME`, `SIM_PASSWORD`, `SIM_SIGNING_KEY`, `SIM_AUTO`, `SIM_STRICT_HTTPS` | see script | only for `pnpm sim:smsgate` |

`SMS_ALLOWLIST` outside production: an empty list sends to nobody. In production an empty list is unrestricted and a non-empty one
restricts (useful for a staging run against the real tablet). Synthetic (seed) numbers are refused in production and, elsewhere,
unless allow-listed.

## 5. Code layout

```
src/integrations/sms/        shared helpers: gsm.ts (normalise + segments), phone.ts, errors.ts, simulator.ts (in-process
                             SimulatorProvider), factory.ts (createSmsProvider from SMS_PROVIDER)
src/integrations/smsgate/    config.ts, provider.ts (SmsGateProvider), signature.ts, webhook.ts (verifyAndParse), types.ts,
                             sim-device.ts (device model), sim-server.ts (HTTP simulator)
src/modules/messaging/
  policy/    classes.ts (class registry: lane, TTL, quiet-hours behaviour, footer), quietHours.ts, canSend.ts, body.ts, optouts.ts
  dispatch/  dispatcher.ts, budget.ts, health.ts, eta.ts, retry.ts, ingest.ts, config.ts, types.ts (repository interfaces),
             memory.ts (in-memory implementations)
  inbound/   keywords.ts, attribution.ts, router.ts (pure), service.ts (glue with InboundEffects), repositories.ts
  templates/ registry.ts, render.ts, format.ts
scripts/sim-smsgate.ts       `pnpm sim:smsgate`
test/fixtures/smsgate/       webhooks/*.json (pre-signed), http.json (recorded exchanges)
```

### Behaviour summary

- **Send path**: `Dispatcher.enqueue` runs `canSendSms`, normalises to GSM-7, adds the STOP footer when required, counts
  segments, computes the expiry (clock starts at quiet-hours release) and writes an outbox item. `tick()` expires, evaluates device
  health (offline holds everything), drops quiet-hours-held classes, orders by lane then age, then sends while the sliding window,
  the lane reserve and the pacing interval allow. `reconcile()` asks the device about messages accepted more than 5 minutes ago
  and unconfirmed. `handleEvent` applies sent/delivered/failed/cancelled/ping/app_started monotonically (delivered beats a late
  failure; a late `sent` only corrects the send time).
- **Lanes**: 0 transactional/urgent (welcome, ready, add-on approval, invites, keyword replies), 1 confirmations, receipts,
  replies, 2 reminders, reviews, late nudges, 3 bulk (emergency, closure notice, broadcast). Lane 0 may use the whole window; the
  others are capped at window minus the reserve (default 24 of 30).
- **Quiet hours** hold only `confirm_request`, `reminder`, `review`, `late_nudge`, `closure_notice`, `broadcast`. Every other
  class is transactional and bypasses them (list in `classes.ts`, asserted in tests).
- **Per-class TTL**: `welcome` 15 min, `late_nudge` 30 min, `in_progress` 30 min, `reminder` 2 h, `ready` 4 h, `emergency` 6 h, and so on.
- **Health**: `unknown` until the first signal, `online` within 3 min of a signal, `degraded` after 3 min of silence, a failed poll,
  a warn/fail health document or a low unplugged battery, `offline` after 10 min of silence or 3 consecutive failed polls or sends.
  `HealthEvaluation.appStarted` tells the host to re-register webhooks.
- **Inbound**: opt-out keywords `STOP STOPALL UNSUBSCRIBE END QUIT`; `START UNSTOP` always opt in; `YES` opts in only when opted out,
  else confirms; `HELP` replies; `C`/`CONFIRM` confirm the next unconfirmed booking; `CANCEL` raises a staff alert and is never an
  opt-out. Keywords are the whole message, trimmed, case-insensitive, edge punctuation ignored. Unknown senders are quarantined and
  no customer is created (a stranger's STOP/START/HELP is still honoured by number). Attribution: job in progress, else nearest
  upcoming within 72 h (an appointment that started up to 2 h ago still counts), else last completed within 14 days.

## 6. What the integrator wires

- **Postgres repositories** for `OutboxRepository`, `DeviceRepository`, `ProcessedEventRepository`, `InboxRepository`,
  `CustomerDirectory` and `OptOutRepository` (maps to `sms_outbox`, `sms_devices`, a processed-events table or the existing
  `webhook_log` unique on envelope id, `sms_inbox`, customers/appointments, `sms_opt_outs`). `OutboxRepository.claim` must be an
  atomic `UPDATE ... WHERE state='pending'`; `recordUsage`/`listUsage` need a small send-log table (or derive from the outbox).
  `ProcessedEventRepository.markIfNew` and the event handling should share one transaction.
- **Webhook route** `POST /hooks/smsgate/:deviceKey`: read the raw body (`addContentTypeParser` with `parseAs: 'string'`),
  `provider.parseWebhook(headers, raw)`, `ingestor.ingest(parsed.event, parsed.extras)`, answer 200 fast. Map `SmsWebhookError`
  codes to 401 (signature, timestamp, headers), 400 (body) and 200 for `unsupported_event` so the device stops retrying events we
  ignore. On `appStarted` call `registerWebhooks`.
- **Jobs** (pg-boss, single leader via advisory lock): `tick` every second or on wake, `reconcile` every 2 min, health poll every
  60 s (`pollDeviceHealth(provider, monitor, deviceId, clock)`), `registerWebhooks` at boot and hourly.
- **Hooks**: `monitor.onTransition` raises the `sms_device_down` alert and the e-mail fallback for `p0FallbackCandidates`.
- **Settings and templates**: `renderTemplate`/`renderSms` with `bodies` from Settings and `linksEnabled = RESCHEDULE_LINK_ENABLED`;
  `validateTemplateBody` for `PUT /messages/templates/:key`.
- **InboundEffects**: `sendReply` becomes `dispatcher.enqueue` with a recipient built from the customer or, for a stranger, a bare
  phone (keyword replies ignore opt-in and opt-out by class).
- **Message status mapping**: outbox `pending/inflight` to messages `queued/sending`, `accepted/sent` to `sent`, `delivered`,
  `failed`, `expired`, `cancelled`; a `suppressed` result from `enqueue` is a failed message with the reason.

## 7. Simulator

`pnpm sim:smsgate` starts the device API with control endpoints (see the banner it prints): inject inbound texts, delivery
receipts and failures, an outage (`down`, `error5xx`, `hang`, `hang_after_accept`), duplicate and out-of-order webhooks, ping and
`app:started`, health warnings. It signs webhooks exactly like the app (re-signed on every retry with the same envelope id) and
retries a rejecting receiver on the app's schedule shape. `SimulatorProvider` is the in-process equivalent for unit tests and
`SMS_PROVIDER=sim`; both are built on `SimDevice`.

Differences from the real app that are deliberate: the simulator accepts one recipient per message, does not model OS limits,
`ttl` expiry or `scheduleAt`, and by default accepts `http://` webhook targets (`SIM_STRICT_HTTPS=true` refuses them like the app).

## 8. Fixtures: provenance

`test/fixtures/smsgate/` was **constructed from the documented payload shapes and the app source and signed with the documented
scheme. It was not captured from a device.** Each file says so. The first task on the real tablet is to capture real deliveries and
exchanges and replace these files; the tests that read them are written against their structure, not their values.
