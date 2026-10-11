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

## Wave W2e: membership matching, the Reminders settings, review leftovers

- **Order matching** (`payments-sync/membership.ts`, `memberships/checkouts.ts`, migration `20261011050000`): the checkout-intent
  tier comes first (the bound order, an open intent's email + product + 72-hour window, then the renewals of a matched intent:
  the same Squarespace customer as its bound order, or the same email when that order names none); then the Squarespace id, a
  **verified** email, the phone. An intent never takes an order another client holds (verifier F1: an intent naming a member's
  email must not take their renewals): another client's Squarespace link of ANY source, the Squarespace customer on another
  client's membership row, another client's email on file even unverified (after the identity migration no email is verified
  and legacy members' contacts were linked by email, so verified-only checks protected nobody), their phone, or their checkout
  row for the same Squarespace customer. Such an intent is ignored and the order links as if it did not exist (its owner, or
  `awaiting_match` / needs-customer for staff); a matched intent never binds a Squarespace customer another client's link or
  membership row holds (`loadIntentRefs` `orderHeldByAnother`, rows staff matched excepted). The cost: a client whose typed email
  is also on another client's record (a family address, a duplicate record) is decided by staff instead of the intent. Residual for W3: an intent still names an email the client only
  typed, so an order from a payer who is not an Oasis client at all goes to the intent's client; `POST membership/start` should
  ask for a fresh step-up (it does) and the page should say the email must be the one they pay with. An unverified email never links, and a
  Squarespace contact the contacts job linked by such an email does not either. A paid order that matches one client only through an
  unverified email opens an `awaiting_match` row (origin `sync`) on that client's membership (a pending one is created when they have
  none), one manager notice and an alert; staff match or reject it (`/api/v1/membership-checkouts/:id/match|reject`). A second paid
  order of the same plan inside the paid period is flagged `duplicate_payment` (alert once per order) and never moves the period; a
  newer payment still releases a hand-set status. `customers.email_verified` drops whenever the email changes, even when the same
  statement sets it (trigger `customers_email_unverify`: a statement cannot show it verified the new address when the flag was
  already true), so a stale flag can never make a new address claim orders. W3 stores a verified email only through
  `memberships/verified-email.ts setVerifiedEmail(tx, customerId, email)`, which names the address in the transaction-local
  setting `oasis.verified_email` for that one statement.
- **Deviations from the design text**: `membership_checkouts` gains `origin` (link | sync), a nullable `checkout_url` (sync rows have
  none) and the state `rejected` (a staff "not this client" must be remembered so the sync does not ask again); "abandoned after 7
  days" closes the pending membership as `canceled` with `cancel_reason` `checkout_abandoned` (no sixth membership status), for
  website joins as well as link checkouts, and sets `manual_status_at` so a late paid order still reactivates it. The 7 days run
  from the last checkout attempt (a restarted checkout gets its full window), and a membership staff made or edited
  (`manual_status_at` set) is never closed. Rows waiting for staff and intents still open keep the membership.
- **Reminders settings** (`/api/v1/settings/reminders`, `set.hours` to save): one version for the 16 settings of the section (the sum
  of their versions) under a per-location advisory lock; per-key audit and `settings.changed`; a preview of the exact texts. The
  reminders job reads `reminders.confirm_request` and appends `reminders.category_prep` for the appointment's categories (template
  variable `{prep}` in `reminder` and `confirm_request`).
- **Review leftovers**: nginx serves stale hours and open times only while one request refreshes them (`proxy_cache_use_stale
  updating`), never through an API outage; the catalog keeps the error staleness. A verified website booking no longer replaces the
  name on file with the typed one; it fills only a placeholder and notes a different name on the booking.
