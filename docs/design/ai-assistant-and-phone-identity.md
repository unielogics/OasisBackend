# Oasis AI assistant, phone identity, personal links, status texts, one catalog — consolidated design (2026-10-10)

Approved plan: /home/ec2-user/.claude/plans/pasted-content-id-dfaa-https-claude-ai-immutable-pony.md (owner decisions are
binding). This document merges the backend architecture, the threat model and the site/rollout design into one spec for
the builders. Where it says MUST, a test must prove it.

## 0. Owner decisions (binding)
- Claude Sonnet 5.5 on Bedrock: Converse API, modelId `us.anthropic.claude-sonnet-5-5` (cross-region profile, us-east-1),
  `@aws-sdk/client-bedrock-runtime@3.1146.0`, instance-role credentials. Judge for evals: `us.anthropic.claude-opus-5-5`.
- AI answers 24/7 to anyone; staff follow AI conversations ONLY in existing places (appointment Messages tab with an
  "Oasis AI" tag; handoffs as Needs-attention alerts); a staff reply pauses the AI on that thread 12 h. No new list.
- Phone = identity. PIN/code typed ONLY on the link page, never in a text.
- Every booking verified: verify once on the page (PIN or texted code) → that phone trusted 30 days → the AI may book/
  reschedule/cancel in chat, EACH action confirmed by a server reply number ("… Reply 4821 to confirm"; the model never
  sees it). Outside the window the AI sends a verify link first. Memberships and payments always need a fresh PIN/code.
- Unknown numbers (owner, 2026-10-11): the FIRST text from an unknown number starts the welcome flow. The client record
  is created at once as a provisional client (source inbound_sms, consent inbound_text, needs_details, name placeholder
  "New texter ••NNNN") so staff see the thread from the start; the AI welcomes (disclosure line), answers the question,
  asks the name (fills the placeholder via set_my_name) and steers to a booking (offers real open times for the wash they
  are interested in; verify link when trust is missing). A lead record is opened in the same step. Provisional clients
  that never give a name and never book are archived (soft-deleted, thread kept for retention) after 30 days.
- Status texts: checked in / wash started, running late, ready for pickup, picked up (thank-you + receipt).
- Settings is the single source of services/prices/details for website, bookings and AI; initial content = the
  website's current lists (Signature/Exterior with member/guest prices, add-ons with VIP inclusion, tint matrix,
  detailing, quote-only "more" services, membership plans Gold $99/mo and VIP $169/mo with perks).
- Reminder settings screen (appointments, status texts, leads); leads get ONE automatic AI follow-up text; categories
  (wash/add-ons/tint/detail/quote) visible across the management system (chips, filter, KPIs, payments split).
- Raise the tablet's Android SMS limit (owner USB step); shop texts keep lane priority over AI replies.

## 1. Data model (migrations; names are proposals, keep them unless the code forces otherwise)
- Catalog: services gain `category` (fk categories.key, NOT NULL; backfill and the default for a new row without one: add-ons →
  addons, tag tint → tint, tags detail/ceramic/exotic/executive → detail (Executive Detail and its + Ceramic are details),
  any other package → wash; the catalog API sets it explicitly from W2), `public_name`, `description`, `member_price_cents`,
  `guest_price_cents`, `vip_inclusion` ('included'|'allowance'|'none') + `vip_note`, `quote_only`, `visible_online`,
  `sort`; table `catalog_categories(key, label, colour, sort, active)`; setting `catalog.tint_matrix` (vehicle types ×
  films → member/guest ranges, VLT options); membership_plans gain `monthly_price_cents`, `perks text[]`,
  `checkout_url` (https, squarespace.com only), `public_label` (Gold/VIP). `appointments.categories text[]` maintained
  on book/edit/add-on change (+ backfill).
- Identity: `client_links` (id, location_id, token_hash unique (sha256 of a 32-byte base64url token), kind
  calendar|verify|pin|membership|pay|book_again, customer_id, phone_e164, appointment_id, invoice_id, plan_key,
  pin_version, phone_version, epoch, issued_by assistant|staff|system, expires_at, uses, max_uses, consumed_at,
  revoked_at/reason); `client_link_sessions` (token_hash pk, link_id, customer_id, phone_e164, trust link|verified,
  verified_by pin|code, step_up_at, idle_expires_at, expires_at, ip); `customer_pins` (customer_id pk, pin_hash
  scrypt over HMAC(PIN_PEPPER, customerId:pin), version, failed_attempts, lock_level, locked_until, set_at, reset_hold_until);
  `phone_trust` ((location, phone) pk, customer_id, verified_at, verified_by, expires_at (+30 d), revoked_at/reason);
  `assistant_pending_actions` (id, conversation_id, customer_id, kind book|reschedule|cancel, payload jsonb, code_hash,
  attempts ≤ max_attempts, expires_at (+15 min), state); OTP table gains `purpose` (website|link_verify|pin_set|pin_reset) and
  `link_session_hash` (ON DELETE SET NULL: deleting a session or its link keeps the code rows, so the hourly ceiling counts every
  code sent; a website code never names a session); customers gain `email_verified boolean default false`. Guards:
  `(location_id, plan_key)` → membership_plans on client_links and membership_checkouts; client_links `expires_at > created_at`;
  phone_trust `expires_at ≤ verified_at + 30 days` (+1 h slack); membership_checkouts `(membership_id, customer_id)` →
  memberships `(id, customer_id)` (on update cascade, so a merge moves the intent with the membership);
  message_threads `ai_paused_by` only with `ai_paused_until`.
- Assistant: `assistant_conversations` ((location, phone) unique, customer_id, pending_since (durable marker),
  last_inbound_at, running_since (lease), handoff_state open|resolved, handoff_reason, last_fallback_at, disclosed_at);
  `assistant_turns` (status running|replied|handed_off|skipped|failed, trust, provider, model, prompt_version, rounds,
  tokens in/out/cache, cost_micros, stop_reason, latency_ms, reply_message_id, transcript jsonb (redacted), error);
  `assistant_tool_calls`; sms_inbox gains assistant_conversation_id/assistant_turn_id and decision 'assistant';
  messages.sender_kind gains 'ai'; message_threads gains ai_paused_until, ai_paused_by; appointments.source gains 'sms_ai'.
- Leads: `leads` ((location, phone) unique, customer_id, source text|website|walk_in, interests text[] (category keys),
  status new|followed_up|booked|closed, first_contact_at, last_contact_at, follow_up_at, follow_up_message_id,
  booked_appointment_id).
- Status texts: `appointment_late_texts` ((appointment, seq 1..2) pk, eta_at, message_id); `pending_checkin_texts` or a
  delayed job keyed by appointment (checked-in text queued +3 min, dropped if cleaning starts first).
- Checkouts: `membership_checkouts` (membership_id, customer_id, link_id, plan_key, product_key, expected_email,
  checkout_url, started_at, expires_at (+72 h), state open|matched|awaiting_match|expired|superseded|abandoned,
  matched_order_id); pending memberships expire to abandoned after 7 d.
- Settings keys (validated, audited, versioned like hours): `assistant.{enabled, stage allowlist|customers|everyone,
  allowlist[], staff_pause_hours=12, faq[{q,a}≤40×500}, actions_enabled}`, `reminders.{offsets_min[], confirm_request,
  category_prep{key:text}}`, `status_texts.{checked_in, checked_in_delay_min=3, running_late, late_grace_min=10,
  late_max=2, ready, picked_up, book_again_link}`, `leads.{follow_up_enabled, follow_up_delay_min=180, business_hours_only,
  within_hours=24 (1..24: the lead_follow_up class's reply window)}`, `catalog.guest_markup_pct=20`.
- Env: `AI_ENABLED`, `AI_ACTIONS_ENABLED`, `AI_PROVIDER=sim|bedrock`, `AI_BEDROCK_REGION`, `AI_BEDROCK_MODEL_ID`,
  `AI_EFFORT=low`, `AI_MAX_TOKENS=800`, `AI_TIMEOUT_MS=20000`, `AI_TURN_DEADLINE_MS=60000`, `AI_DEBOUNCE_MS=8000`,
  caps (`AI_TURNS_PER_NUMBER_HOUR=8`, `AI_TURNS_PER_NUMBER_DAY=25`, `AI_TURNS_UNKNOWN_DAY=10`, `AI_GLOBAL_TURNS_HOUR=100`,
  `AI_GLOBAL_TURNS_DAY=600`, `AI_SMS_SEGMENTS_PER_30MIN=12`, `AI_DAILY_BUDGET_USD=10`), prices
  (`AI_PRICE_INPUT_PER_MTOK`, `_OUTPUT_`, `_CACHE_READ_`, `_CACHE_WRITE_`), `PUBLIC_LINKS_ENABLED=false`, `PIN_PEPPER`
  (secret, Secrets Manager; FORBIDDEN in common.env), `LINK_EPOCH` (setting, bumpable).
- Consent: new opt-in source `inbound_text` (AI-created clients) mapping to a transactional-only consent kind (not in
  MARKETING_CONSENT); `inbound_sms → inbound_text`; keyword stays inbound_reply.

## 2. SMS classes (policy/classes.ts)
- `ai_reply`: priority 1, conversation, transactional, consentExempt ONLY as a reply: deny `no_recent_inbound` unless
  that number's last inbound is < 15 min old; never ignoresOptOut; footer first_only; TTL 15 min; sub-cap
  AI_SMS_SEGMENTS_PER_30MIN in the dispatcher (never touches lane 0's reserve).
- `personal_link` (lane 1, body stored redacted: token masked; the outbox has the real URL), `action_confirm` (lane 1,
  4-digit number, stored redacted), `ai_fallback` (fixed text), `lead_follow_up` (lane 2, held by quiet hours, once per
  lead, consent: reply-related within 24 h of their last text, never to opted-out), `picked_up` (lane 1, transactional),
  `job_delay` (lane 1, TTL 20 min). Checked-in reuses `welcome`.
- Consent of the reply classes (owner-aligned decision, 2026-10-11): `action_confirm` and `personal_link` are consent-exempt
  ONLY as replies within 15 minutes of that number's last inbound text (the same rule as `ai_reply`), and never go to an
  opted-out number. `action_confirm` is refused outside that window (`no_recent_inbound`); a `personal_link` outside it is
  not refused for the window alone but needs normal consent (opted in; an AI-created client's `inbound_text` kind counts,
  it is transactional). `enqueueFor` reads the number's last inbound text and its opt-out (sms_opt_outs by number and the
  client's own opt-out) itself for every reply class, never trusting the caller, so a STOPped number is refused at enqueue.
- Staff never send the AI, link or code classes (`ai_reply`, `ai_fallback`, `personal_link`, `action_confirm`, `otp_code`)
  from the dashboard: `STAFF_SENDABLE` excludes them (tested). The status texts and the lead follow-up are editable
  templates.
- `EnqueueArgs.senderKind` adds 'ai'; `secretVars` for links/codes (outbox real, messages masked); DTO maps ai →
  from:'system', senderName 'Oasis AI', author:'ai'.

## 3. Inbound → AI
- Welcome flow: when the gate admits a number with no client, the turn first creates the provisional client + lead in its
  claim transaction (idempotent per phone), and the context tells the model "new client, name unknown, first contact":
  reply = disclosure + answer + one question for the name + a booking nudge (never more than one question per text).
- Router keeps keyword order (STOP, START/YES-opt-in, HELP, C/CONFIRM, CANCEL) + new `AGENT` → handoff (no AI). Plain
  texts (incl. MMS text) from US/CA mobile numbers (normalizeTextableNanp) → command `assistant` when the gate allows
  (AI_ENABLED, settings enabled + stage/allowlist, not opted out, thread not paused, conversation not in open handoff).
  Else today's path. Digits-only 4–8 char texts: if a pending action exists for that phone → reply-number check (server,
  no model); otherwise redacted before storage/model ("enter codes only on the link page").
- Marker in the webhook transaction (assistant_conversations.pending_since; the inbound stored read for AI-handled
  threads so new_reply alerts don't flood); post-commit kick → pg-boss `ai.respond` (stately, singletonKey=conversation,
  startAfter debounce 8 s; defer while newest < 8 s old up to 45 s); `ai.sweep` every minute re-kicks markers > 30 s and
  fails leases > 3 min (fallback + handoff).
- Turn: gate again → caps → claim (lock, lease, turn row) → context (no phone/ids/tokens: first name, vehicles,
  membership view, trust level, own appointments as A1..A3, today's hours/closures, catalog digest, FAQ, last 20
  messages/48 h, staff lines prefixed "(staff)") → Converse loop (system blocks: static rules + FAQ + catalog digest
  [cachePoint], turn context; tools with cachePoint; toolChoice auto; ≤4 tool rounds then a "reply now" call; 20 s per
  call, 60 s per turn; append-only transcript incl. reasoning blocks) → output guard → enqueue `ai_reply` (first AI text
  of a conversation prefixed with the disclosure "Oasis automated assistant · reply AGENT for a person · STOP to opt
  out.") → audit `assistant.reply` → re-kick if newer texts arrived.
- Output guard: strip markdown, GSM-7, ≤320 chars (one shorten call else cut at a sentence), no URLs except server
  `{link1}` placeholders, every $ amount must appear in this turn's tool outputs, refund/discount/free/guarantee/"ready
  by"/legal words → handoff, never asks for PIN/code/card numbers; a refusal/max-tokens/unknown stop → fallback.
- Failure (Bedrock error, guard, cap, lease timeout): `ai_fallback` "Thanks — a team member will text you back
  shortly." (at most one per 2 h per conversation) + handoff (alert `ai_handoff`, thread unread, notifyManagers kind
  assistant.handoff, AI paused on the thread).
- Loop breakers: 3 identical inbound texts, > 5 texts/min, 6 turns without progress, own number/short codes/alnum
  senders → no AI.

## 4. Tools (zod-validated, strict schemas, customer bound server-side, refs A1..A3 resolve only to own rows)
| tool | trust | does |
|---|---|---|
| get_business_info {topic} | caller | hours (public-hours view), closures 14 d, address, policies, fee settings |
| list_services {category?} | caller | catalog from Settings (the ONLY price source) |
| get_membership_info {} | caller | plans with prices/perks + the client's membership view |
| check_availability {serviceKey, date, partOfDay?} | caller | loadBoard (VIP-aware only when verified) |
| list_my_appointments {} | caller | own upcoming/recent as refs |
| get_balance {} | caller | own open invoices |
| set_my_name {fullName} | caller, provisional client only | fills the placeholder name (never overwrites a real name) |
| note_interest {categories[]} | caller | leads.interests |
| propose_booking {serviceKey, addonKeys[], date, startMin, vehicle?} | trusted (30 d) | validates slot, creates assistant_pending_actions, server texts "… Reply NNNN to confirm"; on the correct reply: createAppointment(channel online, source sms_ai, categories) |
| propose_reschedule {appointmentRef, date, startMin} | trusted | same two-step → rescheduleAppointment |
| propose_cancel {appointmentRef, reason} | trusted, outside the late window, no money held (else handoff) | same two-step → cancelAppointment(notify) |
| send_link {kind, appointmentRef?, tier?} | caller (link goes only to the number on file) | issueClientLink; ≤3/day/phone, 1/kind/hour; returns placeholder |
| opt_out {} | caller | records opt-out (natural language) |
| handoff_to_staff {reason, summary} | caller | handoff |
Untrusted caller asking to book → `needs_verification` → the prompt sends `send_link{verify|calendar}`.
Actor: permissions sched.edit + jobs.status only, audit actor "Oasis AI (SMS)", tool calls logged and audited.

## 5. Personal links and the link API
- URL `https://oasisautospanj.com/#/c|m|p|pin|v/<token>` (fragment; never logged; scrubbed before hydration). TTLs:
  verify/pin 15 min single-use (≤5 exchanges); calendar 72 h (≤3 bookings); book_again 14 d; membership 24 h;
  pay until paid/void (≤7 d). Opening uses nothing; completion consumes.
- Routes under /api/v1/public/links/* (gate PUBLIC_LINKS_ENABLED → 404 before validation; nginx own location + zone ~60/min,
  never cached; Bearer session in a header; JSON only; Origin allowlist when present): POST exchange {token} →
  {session, expiresAt, kind, client{firstName, last2, tier}, trust{verified, until}, invoice?, plan?}; GET me;
  GET availability (no-store, VIP-aware when verified); POST verify/code + verify/code/confirm (code to the link's
  phone only; shares PUBLIC_OTP_TEXTS_PER_HOUR); POST verify/pin; POST pin (after a code ≤10 min); POST pin/reset;
  POST bookings (Idempotency-Key; verified/trusted); POST appointments/:ref/reschedule; POST membership/start {email}
  (fresh step-up ≤5 min, kind membership) → pending membership + checkout intent → {redirectUrl}; POST pay/start (fresh
  step-up, kind pay) → {redirectUrl} (host allowlist). Sessions 15 min idle, 1 h max, re-exchange allowed.
- PIN rules: 4–6 digits; blocklist (top-100 4-digit, all-same, runs, years 1940–2015, last 4/6 of own phone); lockout
  5 fails → 15 min, +3 → 1 h, +3 → disabled until reset (staff notified); ≤10 fails/24 h; per session 5 tries then the
  session dies; per IP 20 fails/h; constant-time and same work when no PIN exists; wrong PIN and unknown state answer
  alike. A PIN outranks a code once set; reset by code holds member privileges 72 h + email notice (SES) + staff notice.
- Stale-record rule: no activity 180+ days or last delivery failed as invalid number → unknown until verified.
- Revocation: phone change, PIN reset, merge, STOP, staff Clear PIN, LINK_EPOCH bump.
- Squarespace: unverified emails never feed linkCustomer's email tier; checkout-intent tier first (expected email +
  product + window); no match → awaiting_match for staff; duplicate paid → flagged; abandoned after 7 d.

## 6. Status texts (port from lifecycle.finish())
Checked in (manual arrive: queue +3 min, drop if cleaning starts), wash started (existing in_progress), running late
(job every 2 min: cleaning past promised end + grace → ETA now+15 rounded to 5; ≤2), ready (existing), picked up
(thank-you; receipt line when balance 0 and no receipt SMS in 2 h; book-again link only with marketing-grade consent).
All read the reminders/status_texts settings; transactional classes; normal consent.

## 7. Website (site repo)
src/client/link.ts captures + scrubs the fragment before hydration; the bridge exchanges and opens the design's sheet
(linked mode: "BOOKING FOR MARIA ••51", skip who/phone/code), per-client board, step-up block (PIN / code / create PIN),
membership (join steps → verify → confirm email → redirect), payment (review block → verify → redirect), dead-link states;
catalog-driven content (DV-CATALOG) from /public/catalog (build snapshot + refresh). DV-LINK, DV-STEPUP, DV-LINK-JOIN,
DV-LINK-PAY, DV-LINK-DEAD. Parity: existing runs unchanged; linked steps vs nearest original states; new blocks via port
goldens + style-token test. e2e checks 10–19 (token only in the exchange body, scrubbed, trust window, verify, PIN
lockout text, membership redirect + pending row, payment redirect + host allowlist, dead links, link preview does not
consume, CSP clean, second link in the same tab).

## 8. Dashboard (live variant only; parity untouched)
"Oasis AI" channelTag; "AI paused — staff replying" line; ai_handoff alert opens Messages; picture-message alert;
Overview "Website PIN: Set · trusted to …" + Clear PIN (cli.edit); Settings: Catalog (website fields, categories with
colours, tint matrix, plans with price/perks/checkout URL), Reminders (offsets, confirm request, category prep texts,
status texts, lead follow-up, previews), Assistant (on/off, stage, allowlist, FAQ); category chips on board cards and the
appointment header, board filter, per-category KPI counts, Payments split by category. DV lines; e2e.

## 9. Bedrock / IAM / ops
provision `--bedrock`: statement InvokeClaude: bedrock:InvokeModel on the inference profile ARN
(arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-sonnet-5-5) and the foundation-model ARNs in
us-east-1/us-east-2/us-west-2 (arn:aws:bedrock:<r>::foundation-model/anthropic.claude-sonnet-5-5); the eval judge uses
the operator profile, not the app role. verify-live: one-token Converse ping. Integrations status key `ai`. Invocation
logging off. AWS Budgets alarm. Kill switches: AI_ENABLED, AI_ACTIONS_ENABLED, settings assistant.enabled/stage,
PUBLIC_LINKS_ENABLED, LINK_EPOCH bump.

## 10. Must-have tests (beyond unit coverage)
spoofed action inside trust never executes without the reply number; injection in names/vehicles/FAQ cannot reach
another record (tools have no id inputs); invented price / URL blocked; AI never answers an opted-out number; +44 sender
gets nothing; 40 inbound texts in 10 min keep AI within its sub-cap while a lane-0 "ready" text goes on time; Bedrock
error/refusal/max-tokens/timeout → fallback; daily cap switches AI off; link token only hashed, absent from logs and
message rows; expired / wrong-purpose / post-PIN-change tokens 401; epoch bump kills sessions; PUBLIC_LINKS_ENABLED=false
→ 404; code endpoint ignores a phone field; PIN lockout/blocklist/constant time; unverified email never links an order;
digits-only texts redacted; staff reply pauses AI; AI-created client fails canSendSms for broadcast; STOP gets no AI reply
and later texts get none; lead follow-up exactly once inside business hours and never after STOP.
