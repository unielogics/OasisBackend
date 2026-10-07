# 0063 Wiring across modules, and deviations from the first spec
Status: accepted (2026-10-07)

Wiring (minimal edits to modules the messaging branch does not own): `OutboundMessage.dedupeKey?` (scheduling ports);
`QueuedSms.invoiceId?` and `QueuedEmail.invoiceId?` (payments messenger, so the thread can file a receipt or payment link under its appointment and the
receipt email can be itemised from the invoice); `src/platform/job-registry.ts`, `src/http/modules.ts`, `src/composition.ts`, `src/server.ts`
(registration and wiring lines); `test/domain-schema/migration.test.ts` (the FK assertion now allows the messaging tables that reference
`messages`, and checks the two domain migrations by text instead).

Deviations and why:
1. **Emergency fan-out is lane 3**, although the Settings port comments say priority 0. Review B15 is binding: a blast at lane 0 starves ready-for-pickup texts.
2. **No `message_templates` table.** The code registry is the source; `GET /messages/templates` reads it. `PUT /messages/templates/:key` (`msg.auto`) is not built;
   editing will need the table, a version column and `validateTemplateBody` (already written).
3. **A `password_reset` template was added** to the registry (the class existed; the people module sends resets).
4. **Refused texts are not persisted** (ADR 0060).
5. **`GET /appointments/:id/messages` returns `{items, customer, unread}`**, not a bare array, so the composer can show opt-out state without a second call.
6. **The hooks listener tolerates an occupied port** (logs an error and keeps serving the API): two stacks on one host must not crash each other. Production should treat that log line as an alert.
7. **`delivered` for invite and reset links is false while the providers are simulators**, so a Super Admin still receives the link in the API response in development.
8. **Seeds:** the simulator device is added by wrapping the `design` profile's run (not by a `dependsOn`), so the reported profile order is unchanged.

Not built, left for later: broadcasts (`POST /messages/broadcast`, P2), reminder and review jobs (M7: `appointments.reminders`, `review_request`), the
reschedule landing page (the `{link}` sentence stays stripped), per-location devices beyond the single location, and the dashboard's use of the thread endpoints.
