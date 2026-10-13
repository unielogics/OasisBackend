-- Kiosk mode, attribution (ADR 0180, wave K1b).
-- 1. staff_events.audit_id: the audit row a staff event was recorded with (no foreign key, like the other audit links). One event per
--    audit row at most, so the history backfill (pnpm staff-events:backfill) can run again and never doubles a live event.
-- 2. square_charges.decided_by_employee_id / decided_kiosk_device_id: who confirmed a saved-card charge, beside decided_by_user_id. The
--    payment may arrive later (the webhook or the job records it in that person's name), and a kiosk has no user: without these the
--    ledger row of a charge confirmed on the kiosk would name nobody.
alter table staff_events add column audit_id bigint;
create unique index staff_events_audit_uq on staff_events (audit_id) where audit_id is not null;

alter table square_charges
  add column decided_by_employee_id uuid references employees(id) on delete set null,
  add column decided_kiosk_device_id uuid references kiosk_devices(id) on delete set null;
