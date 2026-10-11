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

## Wave W2d (messaging plumbing)

The inbound path and the dispatcher are ready for the assistant; nothing answers yet (no turn, no kick consumer) and everything is
inert while `AI_ENABLED=false` or `assistant.enabled=false`. Contract: docs/api-spec.md section 23.4a.

- **Ports** (`src/modules/assistant/ports.ts`): `AssistantGate` (active/allow/reason), `AssistantInbox` (the durable marker and the
  AGENT handoff, in the webhook transaction), `AssistantKick` (after commit), `ActionCodeHandler` (reply numbers). Defaults are off;
  the messaging runtime supplies the Postgres gate and conversation store and looks pending actions up itself, and wave 3 plugs its
  kick and reply-number handler in with `MessagingRuntime.useAssistant()`.
- **Gate**: `active` = AI_ENABLED, assistant.enabled, a real sender that is not ours, a US/CA mobile number, the stage, no opt-out;
  `allow` = active and no staff pause, no open handoff, no loop breaker (3 identical texts within 30 min, more than 5 a minute).
  The turn-level breaker (6 turns without progress) and the caps belong to the turn (wave 3).
- **AGENT** is a keyword only while the assistant serves the number (`active`), so with the assistant off it stays an ordinary message
  and nothing changes for today's texters. It opens a handoff even when the thread is paused or already handed off.
- **Codes**: decided before routing reaches the model. A reply number is recognised whenever an in-chat action is pending for the
  phone, even with the gate closed (a pending action only exists while the AI runs; the handler re-checks the kill switches), so the
  digits are never filed readable. Without a pending action they are masked only while the assistant answers the number: with it off
  "2015" or a ZIP code from a client stays an ordinary message, as before.
- **Strangers** routed to the assistant are not quarantined (wave 3 creates the provisional client from the first text and backfills
  the thread from `sms_inbox.assistant_conversation_id`); a stranger's AGENT stays in the quarantine list with the handoff alert.
- **Staff takeover** is recorded on every staff text, the AI on or off, so turning the AI on never answers a thread staff just
  answered. The "AI paused" line in the dashboard should show only while the assistant is enabled.
- **Sub-cap**: the window accounting (`sms_usage`) records the class of each send (migration `20261011040000_sms_usage_class`); the
  AI classes are counted together against `AI_SMS_SEGMENTS_PER_30MIN` on a fixed 30-minute window, independent of the device window.
