-- Operations vertical: change detection for the per-minute alerts scan, and the indexes the board, calendar and
-- availability reads rely on. No table here references another in-flight branch.

-- The alert set last announced over SSE (a hash of the alert keys), so the scan emits alerts.changed only on a change.
create table ops_alert_state (
  location_id uuid primary key references locations(id) on delete cascade,
  alerts_hash text not null,
  alert_keys text[] not null default '{}',
  updated_at timestamptz not null default app_now()
);

-- Board and calendar windows filter by status within a start-time range.
create index appointments_location_status_start_idx on appointments (location_id, status, scheduled_start);
-- "Next up" per bay and the auto-planned bay count read planned bays by time.
create index appointments_planned_bay_idx on appointments (planned_bay_id, scheduled_start)
  where planned_bay_id is not null;
-- The same-day guarantee counts a client's overrides of that kind within a month.
create index appointment_overrides_kind_idx on appointment_overrides (kind, created_at);
