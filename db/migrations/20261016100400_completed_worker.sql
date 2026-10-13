-- Kiosk mode, Team activity (ADR 0180, K4 review attr:K4A-2): appointments.completed_worker_id, the worker of the car when it was
-- completed. The report's bay minutes and finished cars count for that person: a worker change after completion (allowed, also on the
-- kiosk) no longer moves the bay time to someone else. Cars completed before this migration take their current worker.
alter table appointments add column completed_worker_id uuid references employees(id) on delete set null;
update appointments set completed_worker_id = assigned_employee_id
  where status = 'completed' and completed_at is not null and assigned_employee_id is not null;
