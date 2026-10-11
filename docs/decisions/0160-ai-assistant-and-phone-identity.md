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
