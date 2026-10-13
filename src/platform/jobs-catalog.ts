// The job catalogue: what each registered job is for, who owns it and why it is safe to repeat. The schedule, queue policy,
// retry and expiry columns of docs/jobs.md are generated from the registry itself (renderJobsTable), so the document cannot
// drift from the code; this file holds the facts a definition cannot state. test/jobs/registry.test.ts fails when a
// registered job has no entry here, when an entry has no job, and when docs/jobs.md is not the rendered table.
import type { JobDefinition } from './jobs.js'

export interface JobCatalogEntry {
  /** The module that owns the behaviour. */
  owner: string
  /** What it does, in a sentence. */
  purpose: string
  /** Why a second run (or a retry after a crash) has no second effect. */
  idempotency: string
  /** How the job reads time. */
  clock: string
  /** Who enqueues a queue-only job, and with which singleton key. */
  enqueuedBy?: string
  /** The test files that run it. */
  tests: string
  /** built = added by M7; existing = delivered by its module earlier and audited in M7. */
  status: 'built' | 'existing'
}

export const jobCatalog: Record<string, JobCatalogEntry> = {
  'leads.follow_up': {
    owner: 'assistant (leads)',
    purpose:
      'The one automatic follow-up text of a lead who did not book (ADR 0160, plan J): template lead_follow_up with a personal calendar link when PUBLIC_LINKS_ENABLED, after leads.follow_up_delay_min since their last text, inside business hours when leads.business_hours_only, within leads.within_hours of their last text, never after a STOP since the lead began, never to an opted-out number, only to numbers inside the rollout stage (assistant.stage / assistant.allowlist); a stale record (identity/stale.ts) gets the text a stranger gets (no name, a link bound to the number only). A lead whose client booked since the first contact is closed as booked first, whatever the switches (that sends nothing); no text while AI_ENABLED, assistant.enabled or leads.follow_up_enabled is off.',
    idempotency:
      'One follow-up per lead: the lead row is locked, the text carries the idempotency key lead-follow-up:<lead>, and the lead moves to followed_up with follow_up_message_id; a follow-up that can no longer go clears follow_up_at.',
    clock: 'Injected clock against the last text (lead and sms_inbox), the delay, the window and the business hours of the business tz.',
    tests: 'test/leads/follow-up.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'leads.provisional_archive': {
    owner: 'assistant (leads)',
    purpose:
      'Archives the welcome flow’s provisional clients ("New texter ••NNNN", source inbound_sms, needs_details) that never gave a name and never booked, 30 days after their last text: soft delete with archived_at (reversible: a new text from the number restores the record), the open lead closed, the thread kept for retention, an audit row (ADR 0160). Only rows the assistant created match.',
    idempotency: 'Archives only live provisional rows; an archived row is no longer live, so a repeat finds nothing.',
    clock: 'Injected clock: 30 days after the later of the creation and the last inbound text.',
    tests: 'test/leads/archive.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'maintenance.purge': {
    owner: 'platform',
    purpose:
      'Drops expired idempotency keys, realtime events older than 10 minutes, webhook log rows older than 90 days (unparsed SMS Gate deliveries after 7 days, ADR 0151), and the website’s one-time codes, member tokens and limit counters a day or two past their window (ADR 0150).',
    idempotency: 'Deletes by cutoff; a second run finds nothing left to delete.',
    clock: 'Injected clock for every cutoff.',
    tests: 'test/integration/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'maintenance.retention': {
    owner: 'platform',
    purpose:
      'Daily retention: sessions (7 days past expiry), password resets, messages and SMS inbox and emails (24 months, with the MMS pictures they saved in the photos store, ADR 0151), SMS bookkeeping, VIP release markers, and the phone identity (ADR 0160: personal links, link sessions, wrong-PIN rows, ended phone trust, resolved in-chat actions). audit_log and the ledger are never purged.',
    idempotency:
      'Batched deletes by cutoff, storage objects before their row; a row whose pictures cannot be deleted stays and the run fails after the other tasks (retried); a second run finds nothing left to delete.',
    clock: 'Injected clock; month cutoffs by calendar arithmetic.',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts, test/messaging-db/mms.test.ts, test/identity/purge.test.ts',
    status: 'built',
  },
  'federal_holidays.generate': {
    owner: 'settings',
    purpose:
      'Adds the federal holidays of this and next year as closed days (notify=false); never re-adds a deleted one.',
    idempotency: 'Unique (location, holiday key, year) row; a year that already ran is skipped.',
    clock: 'Injected clock for the current business year.',
    enqueuedBy: 'API start (singleton key "startup", catch-up) and the enable-toggle',
    tests: 'test/settings-http/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'emergency.auto_reopen': {
    owner: 'settings',
    purpose: 'Reopens the shop when an emergency closure reaches its end time.',
    idempotency: 'Reopens only an emergency that is still active and due; a repeat finds none.',
    clock: 'Injected clock against the closure end time.',
    enqueuedBy: 'POST /emergency/close (delayed to ends_at)',
    tests: 'test/settings-http/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'emergency.sweep': {
    owner: 'settings',
    purpose:
      'Backstop for a lost or missed auto_reopen job: reopens any emergency whose end time has passed.',
    idempotency: 'Same guard as auto_reopen.',
    clock: 'Injected clock.',
    enqueuedBy: 'API start (singleton key "startup")',
    tests: 'test/settings-http/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'appointments.late_scan': {
    owner: 'scheduling',
    purpose:
      'Recomputes the Needs Attention set every minute and publishes alerts.changed and kpi.dirty when it differs.',
    idempotency:
      'Compares a hash stored in ops_alert_state under a row lock; an unchanged set publishes nothing.',
    clock: 'Injected clock (late = start + grace, arriving soon).',
    tests: 'test/scheduling/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'appointments.reminders': {
    owner: 'messaging',
    purpose:
      'Queues the 24 h and 2 h reminders (settings reminders.offsets_min) for booked and confirmed appointments: a confirmation request with "Reply C" for booked ones (unless reminders.confirm_request is off), a reminder for confirmed ones, each with the preparation line of the visit’s categories (reminders.category_prep, ADR 0160).',
    idempotency:
      'Message idempotency key reminder:<appointment>:<offset>:<start>; one row lock per appointment.',
    clock:
      'Elapsed-minute offsets from the injected clock; local words from calendar dates; quiet hours in the business tz.',
    tests: 'test/jobs/reminders.test.ts, test/jobs/kill.test.ts, test/jobs/dst.test.ts',
    status: 'built',
  },
  'appointments.review_request': {
    owner: 'messaging',
    purpose:
      'Sends one review request 2 h after a visit is completed, only when settings reviews.enabled is on (default off).',
    idempotency: 'Message idempotency key review:<appointment>.',
    clock: 'Injected clock against completed_at (2 h to 24 h after).',
    tests: 'test/jobs/reminders.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'appointments.checkin_texts': {
    owner: 'status-texts',
    purpose:
      'Sends the "checked in" text that a manual arrival queued status_texts.checked_in_delay_min earlier (pending_checkin_texts); drops it when the wash started first (the "wash started" text went instead), the visit was canceled, the setting is off, the client cannot be texted or it is over 15 minutes late (ADR 0160). Off by default.',
    idempotency:
      'Each pending row is settled once under the appointment and row locks; the text carries the message idempotency key status:checked_in:<appointment>.',
    clock: 'Injected clock against due_at.',
    tests: 'test/status-texts/status-texts.test.ts, test/status-texts/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'appointments.late_texts': {
    owner: 'status-texts',
    purpose:
      'Texts "running a little behind, new estimate h:mm" (now + 15 min, rounded up to 5) to a visit still cleaning past its promised end + status_texts.late_grace_min, the next one only past that estimate + the grace, at most status_texts.late_max per visit, never over 30 minutes after its moment (ADR 0160). Off by default.',
    idempotency:
      'One appointment_late_texts row per (appointment, seq), decided again under the appointment row lock; message idempotency key status:running_late:<appointment>:<seq>.',
    clock: 'Injected clock against the promised end (the booked end, or cleaning start + duration when later) and the last estimate.',
    tests: 'test/status-texts/status-texts.test.ts, test/status-texts/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'vip.hold_release_scan': {
    owner: 'scheduling',
    purpose:
      'Publishes availability.changed for a day when one of its VIP-held slots reaches its release moment.',
    idempotency: 'vip_hold_releases primary key (hold, slot); only a newly inserted row announces.',
    clock:
      'Injected clock; release moment is slot start minus release hours (elapsed time, DST-aware slot start).',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'photos.thumbnail': {
    owner: 'scheduling',
    purpose: 'Writes the thumbnail of an uploaded photo next to the original and stores its key.',
    idempotency: 'Deterministic thumbnail key; rewriting the same object and key changes nothing.',
    clock: 'Not used.',
    enqueuedBy: 'POST /appointments/:id/photos/:photoId/complete (singleton key = photo id)',
    tests: 'test/integrations/media/thumbnail.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'photos.finalize': {
    owner: 'scheduling',
    purpose: 'Marks uploads that never completed (pending for more than 15 minutes) as deleted.',
    idempotency: 'Only rows still pending_upload and older than the cutoff change.',
    clock: 'Injected clock.',
    tests: 'test/scheduling/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'photos.retention': {
    owner: 'scheduling',
    purpose:
      'Removes the stored objects and the row of deleted photos, and of photos older than 24 months (object first, row second).',
    idempotency: 'Storage delete of a missing object succeeds; a row is deleted only after its objects.',
    clock: 'Injected clock; 24 calendar months.',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'payments.lag-scan': {
    owner: 'payments',
    purpose: 'Publishes reconciliation.stale when card money has waited for its processor (Squarespace, or Square) more than 2 hours.',
    idempotency:
      'Read-only apart from the advisory event, which repeats while the condition holds (the dashboard debounces).',
    clock: 'Injected clock.',
    tests: 'test/payments/credit.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'credit.expire': {
    owner: 'payments',
    purpose:
      'Announces store credit that expired unspent (notification to managers, credit.expired event) once per lot.',
    idempotency:
      'credit_expiries primary key (lot); only a newly inserted marker announces. The ledger is never written.',
    clock: 'Injected clock against each lot expires_at; remainder = cents minus FIFO allocations.',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'ledger.integrity_check': {
    owner: 'payments',
    purpose:
      'Nightly proof that every invoice_calc_of row equals calcInvoice over the raw lines and ledger events, that the append-only triggers on ledger_events and credit_allocations exist and are enabled, and that FIFO allocations sum to their credit_apply and never overdraw a lot. Records the result; a problem notifies the managers.',
    idempotency:
      'One ledger_integrity_runs row per location and business date; a re-run with the same result changes nothing and a known problem is not announced twice. The ledger is only read.',
    clock: 'Injected clock for the run time and the business date.',
    tests: 'test/payments/ledger-integrity.test.ts, test/jobs/matrix.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'sms.dispatch': {
    owner: 'messaging',
    purpose:
      'Drains sms_outbox through the SMS Gate device for about 55 seconds per run under the leader lock.',
    idempotency:
      'Atomic claim of outbox rows plus the provider message id; a stately policy allows one active and one queued run.',
    clock: 'Injected clock for token buckets, holds and TTL.',
    tests: 'test/messaging-db/dispatch.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sms.reconcile': {
    owner: 'messaging',
    purpose: 'Asks the device about texts it accepted but never confirmed; expires past-TTL rows.',
    idempotency: 'Only unconfirmed rows are asked about; resend count is capped.',
    clock: 'Injected clock.',
    tests: 'test/messaging-db/dispatch.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sms.device.healthcheck': {
    owner: 'messaging',
    purpose: 'Polls each device and feeds the health state machine (alerts when offline).',
    idempotency: 'Writes the observed state; a transition notifies once.',
    clock: 'Injected clock.',
    tests: 'test/messaging-db/health.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sms.webhooks.register': {
    owner: 'messaging',
    purpose: 'Converges the oasis-* webhooks registered on each device.',
    idempotency: 'Registers only what is missing or different.',
    clock: 'Not used.',
    enqueuedBy: 'API start when SMS_DISPATCH_MODE=jobs (singleton key "boot")',
    tests: 'test/messaging-db/simulator.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'email.send': {
    owner: 'messaging',
    purpose: 'Sends due rows of outbox_emails through the email provider.',
    idempotency: 'Claims a row before sending; sent rows are never claimed again.',
    clock: 'Injected clock for retry timing.',
    tests: 'test/messaging-db/adapters.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.sync': {
    owner: 'payments-sync',
    purpose:
      'Polls Squarespace orders then transactions, matches them to the ledger, runs the membership pass when orders changed.',
    idempotency: 'Upserts by Squarespace id; watermark advances in the same transaction; matches are keyed.',
    clock: 'Injected clock and sleeper.',
    enqueuedBy: 'POST /integrations/squarespace/sync (Sync now)',
    tests: 'test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.contacts': {
    owner: 'payments-sync',
    purpose: 'Hourly full read of Squarespace contacts and customer links.',
    idempotency: 'Upserts by Squarespace id.',
    clock: 'Injected clock.',
    tests: 'test/payments-sync/sync.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.reconcile': {
    owner: 'payments-sync',
    purpose: 'Nightly re-read of the last 45 days to catch what the poll missed.',
    idempotency: 'Upserts by Squarespace id; does not touch the poll watermarks.',
    clock: 'Injected clock. 03:30, not 02:30: the 02:30 hour does not exist on spring-forward day.',
    tests: 'test/payments-sync-db/sync.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.webhook.process': {
    owner: 'payments-sync',
    purpose: 'Fetches the order a verified Squarespace notification names, stores and matches it.',
    idempotency: 'webhook_log unique (provider, notification id) plus the same upsert as the poll.',
    clock: 'Injected clock.',
    enqueuedBy: 'POST /hooks/squarespace after signature verification',
    tests: 'test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'square.event.process': {
    owner: 'square',
    purpose:
      'Processes one Square event claimed in webhook_log (provider square, key event_id): re-fetches its object by id (payment, refund, invoice, subscription, card, customer; amounts in the payload are never trusted), ignores another merchant or location, and runs the ingest handler under an advisory lock per object (ADR 0171). Payments (wave Q2b): the mirror row, the classification, a link payment recorded at once, a counter payment matched after SQUARE_MATCH_DELAY_SECONDS; refunds: the refund legs moved, a refund made in the Square app attached or recorded for review. Cards (wave Q3a): an automatic update copied onto the saved card, a card disabled or forgotten at Square closed with its consents (a membership card: the client texted a card link); customer.deleted closes that Square customer’s cards; a saved-card charge’s payment recorded on its invoice. Invoices and subscriptions (wave Q3b) drive the memberships billed by Square: a paid invoice applies its cycle once and activates a new member, a failed one starts the failure policy, the subscription status and scheduled changes are mirrored; a membership refund that Square failed or rejected is cleared.',
    idempotency:
      'The webhook_log row is claimed once per event id (by the hook or the catch-up) and closed processed or ignored; a processed or ignored row is skipped; a payment is decided once (advisory lock square:payment:<id>, the mirror row, ledger keys square:pay:<id> and square:tip:<id>, and no second live pay of one Square payment), a refund once (its leg, or key square:refund:<id>).',
    clock: 'Injected clock for the row times.',
    enqueuedBy: 'POST /hooks/square after signature verification (singleton key = the event id)',
    tests: 'test/square-db/hook.test.ts, test/square-db/jobs.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.events.catchup': {
    owner: 'square',
    purpose:
      'Every 10 minutes while SQUARE_PROVIDER=live with a token and location: SearchEvents from the watermark minus 10 minutes (never more than 28 days back; the first run reads the last day), each event claimed in the same webhook_log as the hook and processed at once; a failed event holds the watermark back; a complete run with no failure moves it to at least the run time minus 10 minutes; a watermark older than 27 days (runs failing or unfinished that long) is an alert in square_state and the status row. Each run also takes up, from the log itself, whatever the search window, up to 50 Square rows the hook claimed whose job was lost (still received after 15 minutes) and, separately, up to 50 failed rows whose back-off has passed (10 minutes after the last failure, doubling with webhook_log.attempts, at most a day; review Q4 SQ-SEM-5-R1). The first page of the first run of a Square environment stamps the connection point (square_state.connected_at) unless something read it before; a counter payment made before it is mirrored as history, never queued (sandbox run F2).',
    idempotency: 'webhook_log unique (square, event_id): an event the webhook already claimed is skipped (a failed one is run again once its back-off has passed).',
    clock: 'Injected clock for the window and the watermark.',
    tests: 'test/square-db/jobs.test.ts, test/square-db/sim-socket.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.reconcile': {
    owner: 'square',
    purpose:
      'Nightly 03:45 while SQUARE_PROVIDER=live: lists the payments and refunds of the last 72 hours at our location, keeps the counts (by status, source and product) in square_state, and decides every completed payment Oasis has not decided and records every completed refund it has not (the webhook and the catch-up both missed them), through the same paths as the webhook (wave Q2b); the first listing of a Square environment nothing read before stamps the connection point (square_state.connected_at) first, so the earlier counter sales are history (sandbox run F2). The subscription drift check comes with Q3b.',
    idempotency: 'Read-only towards Square; overwrites the last summary; payments and refunds go through the same advisory locks, mirror states and ledger keys as the webhook, so a second run (or a racing webhook) records nothing again.',
    clock: 'Injected clock for the 72-hour window.',
    tests: 'test/square-db/jobs.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.payments.match': {
    owner: 'square',
    purpose:
      'Every minute: the counter (POS) payments past SQUARE_MATCH_DELAY_SECONDS go through the matcher (ADR 0171 D6, plan decision 5): recorded automatically only on strong evidence (R1 the invoice number in the note, R2 a POS intent, R3 one staff "Square reader" entry of that amount, R4 one open invoice of that balance backed by the payer\'s identity; amount alone only with SQUARE_POS_AUTOMATCH=amount); everything else waits in the "Square payments to match" queue with ranked candidates. Finds nothing with the defaults (no payment reaches the mirror while SQUARE_PROVIDER=sim).',
    idempotency:
      'Each payment in its own transaction under the advisory lock square:payment:<id>; only mirror rows still pending are decided; the ledger ops re-check under the invoice lock and never write a second live pay of one Square payment.',
    clock: 'Injected clock against match_after (the payment time plus the delay).',
    tests: 'test/square-db/matching.test.ts, test/square-db/race.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.links.sweep': {
    owner: 'square',
    purpose:
      'Every minute: cancels the active Square payment links whose invoice no longer owes exactly their amount (canceled, paid or changed; a deposit paid; older than 7 days), gives up on pending rows nobody activated (10 minutes; a booking\'s deposit request after a day), and deletes the canceled links at Square (404 counts as done; observe-only too: a clean-up, review Q4 M2). Nothing to do with the defaults (no Square link exists before PAYMENT_PROCESSOR=square).',
    idempotency: 'State moves only forward (active -> canceled/expired, square_deleted_at set once); a second run finds nothing to change.',
    clock: 'Injected clock for the link and pending ages.',
    tests: 'test/square-db/links.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.deposit-link': {
    owner: 'square',
    purpose:
      'Every minute while PAYMENT_PROCESSOR=square and SQUARE_WRITES_ENABLED: each booking\'s deposit request (booking.guest_fee.collect link; written by the website, personal-link and assistant booking paths) becomes a Square quick-pay link for the deposit, texted to the client (ADR 0171 D2: a deposit toward the visit, settled by the cancel and no-show rules). A deposit already paid or a canceled visit drops the request. A request Square refuses for good (a 4xx other than auth, permission or rate limit, a key reused with another body) is given up at once and the managers are told (payments.deposit_link_failed); network errors and 5xx are tried again next minute (review Q4). Skipped with the defaults.',
    idempotency: 'The link is created with the key pl_<row id> (a retry answers the same link) and made live once (pending -> active); the text carries the key payment_link:<row id>.',
    clock: 'Injected clock.',
    tests: 'test/square-db/deposits.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.refunds.submit': {
    owner: 'square',
    purpose:
      'Every minute while PAYMENT_PROCESSOR=square and SQUARE_WRITES_ENABLED: card refunds written for Square money (the refund ledger row is the outbox, ADR 0171 D4) get their legs (newest Square payment first, each capped by what it can still give back) and are sent with RefundPayment; a refund the Square money cannot cover, or a leg Square refuses, marks the refund failed (it stops counting as refunded) and alerts the staff. Skipped with the defaults.',
    idempotency: 'Legs are planned once per refund under the invoice lock; each leg is sent with its own key rf_<leg id> (a retry answers the same refund) and moves only forward (to_submit -> pending -> completed | failed | rejected).',
    clock: 'Injected clock.',
    tests: 'test/square-db/refunds.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.charges.resolve': {
    owner: 'square',
    purpose:
      'Every minute (wave Q3a, ADR 0171 D7): saved-card charges Square did not answer (state unknown, or charging for more than 5 minutes after their process died) are asked again: GetPayment when the payment id is known, otherwise the payment the request made is looked for first (ListPayments around the attempt, by reference_id = the charge id; review Q4), a balance charge whose invoice was canceled or now owes less is closed declined (NOT_SENT, nothing charged), and only then the SAME CreatePayment with the SAME key (ch_<charge id>, or ch_<charge id:attempt> after a decline; the charge is first marked charging with its last request now, so staff Not charged waits for it: review Q4FIX-N1), so Square answers the payment it made or makes it once; the answer is recorded (charged through SquareLedgerOps, declined with its reason). Only with SQUARE_WRITES_ENABLED and within 23 hours of the attempt is anything sent: watch-only or older, the job only looks the payment up and closes a charge Square has no payment for 15 minutes after its last request (declined NOT_SENT, review Q4 H1-R1), so no charge blocks its invoice for good. Nothing exists before a staff member confirms a charge.',
    idempotency: 'The same request with the same idempotency key (Square answers a key’s first result); recording takes the advisory lock square:payment:<id> and the ledger key square:pay:<id>, and a charge already charged is left alone.',
    clock: 'Injected clock against square_charges.attempted_at.',
    tests: 'test/square-db/charges.test.ts, test/square-db/review-q4-charges.test.ts, test/square-db/review-q4-stuck-charge.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.cards.nightly': {
    owner: 'square',
    purpose:
      'Nightly 04:20 (wave Q3a, ADR 0171 D7): the active saved cards of deleted clients are disabled at Square (DisableCard; consents revoked customer_deleted; tried again the next night when Square does not answer or is watch-only); every active card paying a membership whose expiry month ends within 30 days gets a card link texted (template personal_link_card "Your Visa ending in 4242 on file for your membership expires soon. ...", only while personal links are on). Nothing to do with the defaults (no saved cards).',
    idempotency: 'A disabled card is no longer active; the expiry text is sent once per card and expiry (customer_cards.expiry_notice_for, message dedupe key card-expiring:<card>:<yyyy-mm>).',
    clock: 'Injected clock: the expiry month against now plus 30 days (UTC).',
    tests: 'test/square-db/card-lifecycle.test.ts, test/jobs/matrix-square.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'membership.cycle': {
    owner: 'memberships',
    purpose:
      'Rolls manual membership cycles, grants cycle credits, runs the subscription inference (past due, lagged cancel).',
    idempotency:
      'Credit grants keyed by (membership, cycle, rule); the cycle roll is guarded by cycle dates.',
    clock: 'Injected clock.',
    tests:
      'test/memberships/seed-cycle.test.ts, test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'membership.checkouts': {
    owner: 'memberships',
    purpose:
      'Expires open membership checkout intents after their 72-hour window and closes pending website or personal-link memberships staff never edited that saw no paid Squarespace order in the 7 days after their last checkout attempt (canceled, cancel_reason checkout_abandoned, intents abandoned; ADR 0160). Changes nothing when there are none.',
    idempotency:
      'Only open intents past their window and pending memberships with no paid order move, each under a row lock re-checked inside its transaction; a second run finds nothing left to move.',
    clock: 'Injected clock for the window and the 7-day cutoff.',
    tests: 'test/memberships/checkouts.test.ts, test/jobs/matrix-sqsp.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.catalog.sync': {
    owner: 'memberships',
    purpose:
      'Every 5 minutes while SQUARE_WRITES_ENABLED and SQUARE_MEMBERSHIPS_ENABLED (the last rollout stage): the tier prices a save left pending become Square plan variations (one SUBSCRIPTION_PLAN per tier, one STATIC MONTHLY SUBSCRIPTION_PLAN_VARIATION per price row; a price edit is a new row, so a new variation; ADR 0171 wave Q3b); a superseded price nobody used is retired at Square. A failure is kept on the row and the managers are told once per set of failures (again a day later while it lasts). Skipped with the defaults.',
    idempotency:
      'Only rows still pending or failed are sent; each create carries a key derived from the row id and its content (ct_), so a run that stopped after Square answered gets the same object back; a variation with subscriptions is never deleted.',
    clock: 'Injected clock (square_synced_at).',
    tests: 'test/square-members/catalog.test.ts, test/square-members/catalog-plan.test.ts, test/jobs/matrix-square-members.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.catalog.drift': {
    owner: 'memberships',
    purpose:
      'Nightly while SQUARE_WRITES_ENABLED and SQUARE_MEMBERSHIPS_ENABLED: the catalog sync plus Square\'s subscription plans read back and compared with the tier prices; a variation priced differently or deleted at Square while members use it is marked failed and reported (never overwritten), one nobody uses is made again, a renamed tier renames its plan. Skipped with the defaults.',
    idempotency: 'Read-and-compare; the writes are the catalog sync\'s (keyed) and row states that a second run leaves as they are.',
    clock: 'Injected clock.',
    tests: 'test/square-members/catalog.test.ts, test/jobs/matrix-square-members.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.enrollments.resume': {
    owner: 'memberships',
    purpose:
      'Every 5 minutes while SQUARE_WRITES_ENABLED: membership-page enrollments younger than an hour are taken on with the same keys (CreateSubscription sb_<enrollment> after a lost answer; the subscription and first invoice read back when an event is late); older ones are read back once more and then abandoned (kept while Square does not answer); a failed or abandoned one is cleaned up at Square (subscription canceled, open invoice canceled, card disabled) and its membership canceled unless a newer attempt uses it (after a failed first payment the client is texted a new membership page); pending Square memberships with no attempt for an hour are closed; a member who saved a newer card for membership billing has it put on the subscription. Skipped with the defaults.',
    idempotency:
      'Every Square create repeats its own key; cancels and disables count "already done" answers as done; each row moves forward only, under a row lock re-checked in its transaction; texts carry dedupe keys.',
    clock: 'Injected clock (the one-hour window).',
    tests: 'test/square-members/enroll.test.ts, test/jobs/matrix-square-members.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'membership.billing': {
    owner: 'memberships',
    purpose:
      'Daily 09:30 (shop time): the failure policy of memberships billed by Square (ADR 0171 D10, setting memberships.billing_policy {graceDays 7, cancelDays 21}): a client the invoice event could not tell is texted the card link; on day 7 the membership is past due (perks off); on day 21 the subscription and its open invoice are canceled at Square (writes on) and the membership canceled payment_failed. Finds nothing with the defaults.',
    idempotency: 'Each step is guarded by the membership state re-checked under a row lock; the notice has a dedupe key; Square cancels count "already" answers as done.',
    clock: 'Injected clock; shop-local calendar days.',
    tests: 'test/square-members/billing.test.ts, test/jobs/matrix-square-members.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'square.plans.swap': {
    owner: 'memberships',
    purpose:
      'Daily 10:15 while SQUARE_WRITES_ENABLED: "Move members" price moves whose notice has run (ADR 0171 D9) send SwapPlan to the tier\'s current price at the size (an earlier scheduled swap removed first); Square swaps at the next billing date and the subscription event moves the membership. Skipped with the defaults.',
    idempotency: 'A move is sent once (its effective date is recorded); a repeat replaces the scheduled swap with the same one.',
    clock: 'Injected clock (the notice end).',
    tests: 'test/square-members/actions.test.ts, test/jobs/matrix-square-members.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'standing.materialize': {
    owner: 'standing',
    purpose:
      'Books the next four weeks of every active standing (recurring) series of a VIP client; a date that cannot be booked is recorded as skipped with its reason. Does nothing while features.standing_waitlist is off.',
    idempotency:
      'One standing_occurrences row per (series, date) under a unique key, and the series watermark only moves forward; a second run books nothing new.',
    clock: 'Injected clock, business-timezone dates.',
    tests: 'test/standing/jobs.test.ts, test/standing/standing.test.ts, test/jobs/registry.test.ts, test/jobs/matrix.test.ts',
    status: 'built',
  },
  'standing.autoconfirm': {
    owner: 'standing',
    purpose:
      'Confirms standing appointments whose series has auto-confirm on, once they are inside the confirmation window.',
    idempotency: 'Confirms only appointments still in booked status; a repeat finds none.',
    clock: 'Injected clock against each appointment start.',
    tests: 'test/standing/jobs.test.ts, test/jobs/registry.test.ts, test/jobs/matrix.test.ts',
    status: 'built',
  },
  'waitlist.offer_expiry': {
    owner: 'standing',
    purpose:
      'Lapses waitlist offers nobody accepted in time and offers the slot to the next matching entry (VIPs first when that toggle is on).',
    idempotency:
      'Moves only open offers past expires_at; the next offer is unique per (entry, slot_start), so a repeat neither lapses nor offers twice.',
    clock: 'Injected clock against expires_at.',
    tests: 'test/standing/waitlist.test.ts, test/standing/jobs.test.ts, test/jobs/registry.test.ts, test/jobs/matrix.test.ts',
    status: 'built',
  },
  'ai.respond': {
    owner: 'assistant',
    purpose:
      'One turn of the AI text assistant for a conversation whose texts wait (ADR 0160): deferred while the newest text is under AI_DEBOUNCE_MS old (at most 45 s after the first), then the gate again, the caps, the claim, the Converse loop, the output guard and the reply (or the fallback and a handoff). Returns at once while AI_ENABLED=false.',
    idempotency:
      'Stately per conversation (singletonKey); the turn claims the conversation under a row lock and a 3-minute lease, answers only while its marker (pending_since) is set and clears it, and queues the reply with a per-turn dedupe key.',
    clock: 'Injected clock for the debounce, the lease, the caps and the reply window; monotonic time only for latencies.',
    enqueuedBy: 'the webhook after commit (assistant kick, singleton key = the conversation, 8 s later), the turn itself (deferral, newer texts) and ai.sweep',
    tests: 'test/assistant/jobs.test.ts, test/assistant/conversations.test.ts, test/assistant/guard.test.ts, test/assistant/prompt.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'ai.sweep': {
    owner: 'assistant',
    purpose:
      'Backstop of the assistant (ADR 0160): re-kicks conversations whose texts have waited over 30 s with no turn running, and fails turns that held their lease over 3 minutes (the fallback text and a handoff to staff). Returns at once while AI_ENABLED=false.',
    idempotency: 'Kicks collapse on the stately ai.respond queue; a dead lease is failed under a row lock once (the lease is cleared in the same transaction).',
    clock: 'Injected clock against pending_since and running_since.',
    tests: 'test/assistant/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
}

const policyOf = (d: JobDefinition<never>): string => d.policy ?? 'standard'

/** Retry and expiry as the queue gets them (the defaults of createJobs applied). */
export const retryText = (d: JobDefinition<never>): string =>
  `${d.retryLimit ?? 3} x ${d.retryDelaySeconds ?? 30}s backoff; expires ${d.expireInSeconds ? `${d.expireInSeconds}s` : '15m (pg-boss default)'}`

export const scheduleText = (d: JobDefinition<never>, defaultTz: string): string =>
  d.cron ? `\`${d.cron}\` ${d.tz ?? defaultTz}` : 'queue only'

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The catalogue table of docs/jobs.md, generated from the registry and the catalogue. */
export function renderJobsTable(defs: readonly JobDefinition<never>[], defaultTz: string): string {
  const head = [
    '| Job | Owner | Schedule | Queue policy | Retry / expiry | What it does | Idempotency | Clock | Enqueued by | Tests | Status |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  const rows = [...defs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const c = jobCatalog[d.name]
      return `| \`${d.name}\` | ${cell(c?.owner ?? 'MISSING')} | ${scheduleText(d, defaultTz)} | ${policyOf(d)} | ${cell(retryText(d))} | ${cell(c?.purpose ?? 'MISSING')} | ${cell(c?.idempotency ?? 'MISSING')} | ${cell(c?.clock ?? 'MISSING')} | ${cell(c?.enqueuedBy ?? (d.cron ? 'cron' : 'MISSING'))} | ${cell(c?.tests ?? 'MISSING')} | ${c?.status ?? 'MISSING'} |`
    })
  return [...head, ...rows].join('\n')
}

export const JOBS_TABLE_START = '<!-- jobs-table:start -->'
export const JOBS_TABLE_END = '<!-- jobs-table:end -->'

/** docs/jobs.md with its generated block replaced. */
export function withJobsTable(doc: string, table: string): string {
  const a = doc.indexOf(JOBS_TABLE_START)
  const b = doc.indexOf(JOBS_TABLE_END)
  if (a < 0 || b < a) throw new Error('docs/jobs.md has no jobs-table markers')
  return `${doc.slice(0, a + JOBS_TABLE_START.length)}\n${table}\n${doc.slice(b)}`
}
