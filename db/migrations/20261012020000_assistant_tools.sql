-- The assistant's tools and the welcome flow (ADR 0160, wave W3b; design sections 0 and 4):
--   - vehicles.vehicle_type: the tint price class of a vehicle (set_my_vehicle: sedan/coupe, SUV/crossover, truck/van), so the team
--     sees which tint row applies without asking again;
--   - customers.archived_at: a provisional client of the welcome flow ("New texter ••NNNN") who never gave a name and never booked
--     is archived after 30 days: soft-deleted (deleted_at, so the number is free again and the thread is kept for retention) and
--     marked archived_at, which is what tells such a row apart from a deletion; a later text from the number restores it.
alter table vehicles add column vehicle_type text check (vehicle_type is null or vehicle_type in ('sedan_coupe', 'suv_crossover', 'truck_van'));

alter table customers add column archived_at timestamptz;
alter table customers add constraint customers_archived_is_deleted check (archived_at is null or deleted_at is not null);
-- the nightly archive scan: live provisional clients by age
create index customers_provisional_idx on customers (created_at)
  where source = 'inbound_sms' and needs_details and deleted_at is null and merged_into is null;
-- a returning texter's archived provisional record, found by number
create index customers_archived_phone_idx on customers (phone_e164) where archived_at is not null;
