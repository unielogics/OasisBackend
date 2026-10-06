# 0054 Payments: invoice lifecycle, numbering and the gateway

Status: accepted (2026-10-06)

* One invoice per appointment, **created at booking** through `InvoiceGateway.ensureForAppointment` (idempotent per
  appointment). Numbers are `INV-<n>` from `invoice_counters` (per location, starts at 20611, after the highest design id
  20610), incremented under the counter row's lock **in the caller's transaction**: gap-free, a rolled-back booking leaves no
  gap, concurrent bookings get consecutive numbers.
* `biz_date` is the business date of the **service**, set from the appointment time at booking and frozen only by
  `freezeDate` (completion), never by the first ledger event (review B3, C4): a deposit at booking does not move the invoice
  into the booking day. `occurred_at` is the service instant; each ledger event keeps its own `occurred_at`. Payments ranges,
  the list sort and the chart use `biz_date` / the invoice's `occurred_at`; "Revenue today" (Operations) is cash-basis and sums
  events occurring today.
* Lines are price snapshots. `syncItems` diffs by (kind, name, price) so lines that stay keep their ids (refund-by-item
  tracking survives an add-on being added elsewhere). A removal that would leave `paid - refunded > total` is refused with 409
  `ADDON_REMOVE_OVERPAID`; adding a line after payment reopens a balance.
* Canceling an appointment cancels its invoice (`canceled_at`, `cancel_reason`); a **no-show cancels it too** (review B2) so
  it stops counting as Outstanding. Statuses `canceled`, `canceled_kept`, `canceled_refunded` (ADR 0050). Balance is 0 for a
  canceled invoice; a kept deposit stays in `paid`.
* `InvoiceSummary.depositCents`: `paid` while a part payment leaves a balance, otherwise the sum of payments flagged as
  deposits. `payMethodLabel` is the method of the latest non-voided payment or credit application.
* Foreign keys left for later: none open; `ledger_events` / `invoices` reference `appointments`, `customers`, `users`,
  `employees`, `services`, `appointment_addons` which exist. `payment_links.sent_message_id` is a plain uuid until the
  messages table (Messaging) exists.
