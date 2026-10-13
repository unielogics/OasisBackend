-- Kiosk mode, attribution columns (ADR 0180): a kiosk request has no user, so the employee who tapped their name is recorded next
-- to the existing user columns. Columns only (wave K1a); the writes come with the attribution package (wave K1b). Payments and texts
-- already attribute by employee (ledger_events.actor_employee_id, messages.sender_employee_id), so neither table changes here.
alter table activity_log
  add column actor_employee_id uuid references employees(id) on delete set null,
  add column kiosk_device_id uuid references kiosk_devices(id) on delete set null;
-- who booked the visit
alter table appointments add column created_by_employee_id uuid references employees(id) on delete set null;
alter table appointment_addons add column added_by_employee_id uuid references employees(id) on delete set null;
alter table appointment_photos add column uploaded_by_employee_id uuid references employees(id) on delete set null;
alter table payment_links add column created_by_employee_id uuid references employees(id) on delete set null;
