# 0040 Scheduling module: ports, wiring and what it does not own

Status: accepted (2026-10-06)

The Operations vertical (`src/modules/scheduling`) depends on three things other verticals own, each behind a narrow port in
`ports.ts` with an in-memory implementation, so it builds, tests and runs alone:

- **`InvoiceGateway`** (payments; the contract is shared and binding): `ensureForAppointment`, `syncItems`,
  `cancelForAppointment`, `summariesFor`. Invoices exist from booking. Scheduling never reads ledger tables. Assumptions the
  payments module must honour: `paidCents` is the money currently held (payments minus refunds), `balanceCents` is 0 on a
  canceled invoice, `ensureForAppointment` on an existing invoice refreshes its date and revives a canceled one (reschedule
  and reopen rely on it), `syncItems` throws 409 `ADDON_REMOVE_OVERPAID` before changing anything. The contract has no
  refund instruction on cancel, so the deposit policy is recorded and echoed, not executed.
- **`MessageQueue`**: `enqueue(tx, {templateKey | text, customerId, appointmentId, vars, purpose})` inside the command's
  transaction. Templates come from `src/modules/messaging/templates`; cancellation has no template and queues free text as a
  staff message. The in-memory queue renders and records. A refused message (opt-out, no number) comes back as
  `{queued: false, skipped}` and the activity line says `(not sent: ...)`.
- **`MembershipPort`**, **`ExternalAlertSource`** (alerts 10-12), **`RevenueSource`** (cash-basis revenue). Without a
  `RevenueSource` the Revenue tile falls back to the fully paid invoices of today's jobs, the design's own rule.

`createSchedulingModule(ports)` is the wiring point; `schedulingModule` (default ports) is registered in
`src/http/modules.ts`. The worker calls `configureSchedulingJobs(ports)` so the alerts scan sees the same gateway.
`customersModule` registers only the customer search and create routes the booking panel needs.

Not in this module: payments and invoices, SMS persistence and the inbound router, memberships, the Settings HTTP routes (the
Settings checklist route calls `syncChecklistTemplate` after `putChecklist`), geofence ingest (`/arrivals/ping`), the waitlist
and standing appointments (P2), and the dev simulate-arrival route (`arrive {source: geofence}` is the same transition).
