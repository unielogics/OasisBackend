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
  charges today (the seed sets it to the guest price); charging members their price at booking is a later wave's.
- **Public catalog** (`GET /public/catalog`) extended in place (every field the website reads today kept): categories, member/guest
  prices, VIP inclusion, quote-only items, the tint matrix, the guest fee, plan prices and perks. Checkout URLs stay internal: only a
  verified membership link leads to one.
- **`appointments.categories`** maintained by `createAppointment`, add-on add/remove and a service's category change (open visits);
  `visitCategory()` gives the chip/KPI word (`mixed` when two categories other than add-ons meet).
- **Seed `website-catalog`** makes the website's content the production catalog and deactivates (never deletes) the rest; idempotent.
  Durations the design does not give were chosen by the seed (tint 180, interior detail 150, full detail 240, quotes 120/480/300/30
  minutes) for the owner to review.

