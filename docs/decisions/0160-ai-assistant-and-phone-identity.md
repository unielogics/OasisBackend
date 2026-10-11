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

- **Model**: Claude on Amazon Bedrock (Converse API, instance-role credentials): Claude Sonnet 5.5 (`us.anthropic.claude-sonnet-5-5`)
  as decided, and **for now Claude Sonnet 4.6** (`us.anthropic.claude-sonnet-4-6`, the default of `AI_BEDROCK_MODEL_ID`; judge Opus
  4.6) because the account's Claude 5.x quota is 0 (owner, 2026-10-11); the switch is that one setting. Behind
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

## Wave W2c (the Bedrock provider)

- `BedrockProvider` (`src/integrations/ai/bedrock.ts`) implements the port with `ConverseCommand` of
  `@aws-sdk/client-bedrock-runtime@3.1146.0`: system blocks each followed by a `cachePoint` when `cache` is set, the tools (strict,
  `toolChoice: auto`) followed by a `cachePoint` with `cacheTools`, `inferenceConfig.maxTokens`, reasoning blocks passed back
  unchanged (text + signature, or the redacted bytes as base64 in the port), at most four cache points. The mapping is pure and
  key-ordered, so the same request is the same bytes (tested over HTTP). `AI_PROVIDER=bedrock` builds it; building contacts nothing.
- **Models (owner change, 2026-10-11)**: one list, `src/integrations/ai/models.ts` (profile id, foundation model, list prices): Sonnet
  4.6 (`us.anthropic.claude-sonnet-4-6`, the interim assistant and the default), Opus 4.6 (`us.anthropic.claude-opus-4-6-v1`, judge),
  Sonnet 5.5 and Opus 5.5. The IAM grant, the default prices and the status row read it. The request mapping is the same for every
  model (tested: only `modelId` differs; no thinking, reasoning or other version-specific field), so moving to Sonnet 5.5 is
  `AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5-5` after `verify:ai --model us.anthropic.claude-sonnet-5-5 --probe-effort`.
- **Effort**: the SDK has Converse's own `outputConfig.effort`; whether a model on Bedrock takes it (or the Anthropic
  `output_config` through `additionalModelRequestFields`) is not known yet, so `AI_BEDROCK_EFFORT_MODE` (`off` | `output_config` |
  `additional_fields`) defaults to **off** and `pnpm verify:ai --probe-effort` decides, per model. While off the model runs at its
  default effort (`high` for Sonnet 4.6 and 5.5).
- **toolChoice `none`** does not exist in Converse: without tool blocks in the conversation the tools are left out; with them
  Bedrock requires the tool configuration, so it goes out unchanged (auto) and the assistant must treat a tool call on its final
  "reply now" call as a fallback (and say "reply now without tools" in that call's text).
- **Errors**: one SDK retry (`maxAttempts: 2`) for throttling and outages, a per-call `AbortSignal` (`AI_TIMEOUT_MS`, combined with
  the caller's turn deadline). Kinds: `throttled` / `unavailable` retryable; `access_denied`, `invalid_request`, `timeout`, `aborted`,
  `unknown` not. "Not available for this account" (the account quota of 0) is `access_denied` whatever exception carries it. Messages
  carry the exception name and the AWS text masked, without quoted parts, cut at 200 characters (never the prompt). The error's
  `cause` is not the SDK error but a `BedrockErrorCause` with the same safe text (none for a timeout or an abort), the exception
  name, HTTP status, request id, network code and stack frames: the logger appends the cause chain to a logged error, so the raw
  AWS text never reaches the logs either.
- **Stop reasons**: `refusal` → `refused`, `content_filtered` / `guardrail_intervened` → `content_filtered`, anything else unknown
  (malformed output, context window exceeded, a new value) → `other`, raw value kept. A content block the port cannot carry is an
  error rather than a shortened transcript.
- **Cost**: `aiCostMicros(usage, aiPricesFromEnv(env))`: tokens × USD per MTok = micro-dollars; Bedrock's input count excludes the
  cache reads and writes. `AI_PRICE_*` have no default any more: each unset one is the configured model's list price (Sonnet 4.6:
  3 / 15 / 0.30 / 3.75), a model outside the list gets the highest listed rates; `resolveAiPrices` also says the source (`env`,
  `model`, `mixed`, `highest`), shown as `priceSource` in the status row.
- **IAM / ops**: `pnpm aws:provision --bedrock` (statements `InvokeClaude` on the four inference profiles, `InvokeClaudeRouted` on
  their foundation models in the three routed regions only through those profiles; the only wildcard is `anthropic.claude-opus-4-6-v1*`;
  no `--bedrock-model`: the list is code); `pnpm verify:ai` (one-token ping; IAM, model access, quota named for the configured model;
  a model outside the list fails AI-01; `--model` tries another one); `GET /system/integrations` row `ai` (`modelLabel`, `priceSource`,
  a warning for an unlisted model). The design's eval judge runs under the operator profile, but the owner's change puts both judges
  in the app role's list too (one list, nothing broader than the four). docs/aws-setup.md has the quota support case, the Budgets alarm and invocation logging off.

## Wave W2d (messaging plumbing)

The inbound path and the dispatcher are ready for the assistant; nothing answers yet (no turn, no kick consumer) and everything is
inert while `AI_ENABLED=false` or `assistant.enabled=false`. Contract: docs/api-spec.md section 23.4a.

- **Ports** (`src/modules/assistant/ports.ts`): `AssistantGate` (active/allow/reason), `AssistantInbox` (the durable marker and the
  AGENT handoff, in the webhook transaction), `AssistantKick` (after commit), `ActionCodeHandler` (reply numbers), `NewTexters` (the
  welcome flow's provisional client, in the webhook transaction). Defaults are off;
  the messaging runtime supplies the Postgres gate and conversation store and looks pending actions up itself, and wave 3 plugs its
  kick, reply-number handler and welcome flow in with `MessagingRuntime.useAssistant()`.
- **Gate**: `active` = AI_ENABLED, assistant.enabled, a real sender that is not ours, a US/CA mobile number, the stage, no opt-out;
  `allow` = active and no staff pause, no open handoff, no loop breaker (3 identical texts within 30 min, more than 5 a minute).
  The turn-level breaker (6 turns without progress) and the caps belong to the turn (wave 3).
- **AGENT** is a keyword only while the assistant serves the number (`active`), so with the assistant off it stays an ordinary message
  and nothing changes for today's texters. It opens a handoff even when the thread is paused or already handed off.
- **Codes**: decided before routing reaches the model. A reply number is recognised whenever an in-chat action is pending for the
  phone, even with the gate closed (a pending action only exists while the AI runs; the handler re-checks the kill switches), so the
  digits are never filed readable. Without a pending action they are masked only while the assistant answers the number: with it off
  "2015" or a ZIP code from a client stays an ordinary message, as before.
- **Strangers** routed to the assistant are not quarantined. The welcome flow (owner, 2026-10-11: the provisional client exists from
  the first text) plugs in through `NewTexters.adopt`, called in the webhook transaction before the marker: when it returns a client
  the first text is filed read in that client's thread at once. If wave 3 prefers to create the client at the turn's claim instead,
  the stranger's texts are found by `sms_inbox.assistant_conversation_id` and filed then. A stranger's AGENT stays in the quarantine
  list with the handoff alert (no adoption: the person asked for staff, not the welcome flow).
- **Verifier fixes (W2d)**: (F1) the number a text was sent to is only the payload's `recipient`; the SMS Gate parser falls back to
  `phoneNumber`, which on `sms:received` is the sender, and taking it would have held every texter back as "our own number" on a
  device that omits `recipient`. (F2) `webhook_log` keeps no code readable in a second envelope of the same device message (masked
  when the inbox row was) nor in a row never routed (unknown device, given up by the sweep: digits-only 4-8 is masked, since nothing
  decided it was not a code). (F3) AGENT pages the managers when the handoff opens, not again while it is open, so repeating it (a
  stranger included, once the stage is `everyone`) cannot flood their notifications.
- **Staff takeover** is recorded on every staff text, the AI on or off, so turning the AI on never answers a thread staff just
  answered. The "AI paused" line in the dashboard should show only while the assistant is enabled.
- **Sub-cap**: the window accounting (`sms_usage`) records the class of each send (migration `20261011040000_sms_usage_class`); the
  AI classes are counted together against `AI_SMS_SEGMENTS_PER_30MIN` on a fixed 30-minute window, independent of the device window.

## W3 contract (the seam between the turn and the tools)

`src/modules/assistant/contract.ts` (types and two constants, no logic) lets the turn (W3a) and the tools, actions, welcome flow and
leads (W3b) be built in parallel. Compiling stubs sit at the agreed paths and keep the W2d "off" defaults until each package lands:
`assistant/tools/index.ts` (`createToolRegistry`: no tool), `assistant/actions/handler.ts` (`createActionCodeHandler`:
`noActionCodes`), `assistant/welcome/new-texters.ts` (`createNewTexters`: `noNewTexters`), `leads/index.ts` (`createLeads`,
`createLeadJobs`: no job) and `assistant/facts.ts` (`buildShopFacts` / `renderShopFacts` throw "not built"). Nothing is wired or
registered by the contract. Test: `test/assistant/contract.test.ts`.

- **Identity of a turn** (`TurnIdentity`): location, phone (server side only, never shown to the model), client or null,
  provisional, trust `unknown` | `caller` | `trusted` (+ `trustUntil`). `unknown` = a stranger or a stale record; `caller` = the live
  client on file (the provisional one included; stored as `known` in `assistant_turns.trust`); `trusted` = a live phone trust.
- **Minimum trust per tool** (`TOOL_MIN_TRUST`): the design's §4 "caller" on the public tools means anyone texting, so they are
  `unknown` here (business info, services, membership plans, availability, interests, send_link verify/calendar, opt-out, handoff);
  the client's own record is `caller` (appointments, balance, name on a provisional client, vehicle); `propose_*` are `trusted` and
  flagged `action` (offered only while `AI_ACTIONS_ENABLED` and `assistant.actions_enabled`). Below the minimum, W3a answers
  `needs_verification` without running the tool.
- **Shop facts** (`ShopFacts`, design §3b): business, contact (texting vs calling), hours, closures (30 days), today, booking
  rules, fee, cancellation, VIP, arrival, automatic texts, catalog (categories; items with member/guest STARTING prices, VIP
  inclusion, quote-only; tint rows with "from" prices only), plans, FAQ; `version` is the hash of the source versions and the
  business date (the cache key); `renderShopFacts` is deterministic and leaves `generatedAt` out (prompt cache). Whether the shop
  is open now is not a fact: the turn context carries the time.
- **Tool context** (`ToolContext`): db, clock, the turn's `now`, ids, env, identity, conversation and turn ids, facts, refs
  (`A1`..`A3` resolve only to the client's own appointments), `actionsEnabled`, the location's scheduling context and the AI actor
  (`Oasis AI (SMS)`, sched.edit + jobs.status), the queue, the turn deadline's signal, `addLink(url, {kind, expiresAt})` →
  `{linkN}` (the reply goes out with the URL as a secretVar, class `personal_link`), `handoff(reason, summary)`,
  `audit(tx, action, detail)` and `setCustomer(id)`. Deviation from the brief: `audit` takes the tool's transaction, so the audit
  row commits with the change it records.
- **Tool inputs** (`ToolInputs`): strict, every property required (null = not given), no client, phone, id or price; dates are
  business dates and `startMin` minutes from midnight; appointments by ref.
- **Outcomes** (`ToolOutcome`): `ok` with JSON `data` (no phone, id, token, URL or code), or an error kind (`needs_verification`,
  `not_allowed`, `invalid`, `not_found`, `unavailable`, `rate_limited`) with a plain message; either may ask for a handoff.
  `amountsCents` declares the only $ amounts a reply may state besides the facts' starting prices, plan prices and fee: the
  client's own open balance (`get_balance`; a balance is not a price, so §3b does not forbid it).
- **Factories**: every W3 part takes the same `AssistantDeps` (db, clock, ids, env, queue, log, facts source,
  `schedulingFor(location)`, `actorFor(location)`), built once by W3a's wiring. `createLeads` (open / noteInterest / markBooked) is
  added beyond the brief so the link API's bookings and the reply-number handler close a lead the same way.
