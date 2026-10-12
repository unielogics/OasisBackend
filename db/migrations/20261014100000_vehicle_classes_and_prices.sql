-- Prices by vehicle size (ADR 0170, plan decision 1). Every location gets an editable list of vehicle sizes (Compact car, Large car,
-- Compact SUV, Large SUV, Truck by default; the key never changes, sort is size order, smallest first), and every service gets one
-- regular price per size (a missing row = not set). These replace the member/guest prices, the guest markup and the tint matrix as
-- what the shop charges; the old columns and settings stay, read only, until a later release drops them. Nothing is invented: the
-- backfill copies today's guest prices to the first size and today's tint matrix to the matching sizes. Vehicles gain their size.

create table vehicle_classes (
  location_id uuid not null references locations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  label text not null check (btrim(label) <> '' and length(label) <= 40),
  -- size order, smallest first: the first active size prices a visit whose size is not known
  sort integer not null default 0,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  primary key (location_id, key)
);

-- The defaults for every location that exists now; new locations get them from ensureDomainDefaults (catalog/vehicle-classes.ts).
insert into vehicle_classes (location_id, key, label, sort)
select l.id, c.key, c.label, c.sort
from locations l
cross join (values
  ('compact_car', 'Compact car', 10),
  ('large_car', 'Large car', 20),
  ('compact_suv', 'Compact SUV', 30),
  ('large_suv', 'Large SUV', 40),
  ('truck', 'Truck', 50)
) as c(key, label, sort)
on conflict do nothing;

-- The regular price of a service at a size. max_cents makes a range ("from $229 to $279", tint); null = one price.
create table service_class_prices (
  service_id uuid not null references services(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  class_key text not null,
  price_cents integer not null check (price_cents between 0 and 10000000),
  max_cents integer check (max_cents is null or (max_cents >= price_cents and max_cents <= 10000000)),
  updated_at timestamptz not null default app_now(),
  updated_by uuid,
  primary key (service_id, class_key),
  constraint service_class_prices_class_fkey foreign key (location_id, class_key)
    references vehicle_classes (location_id, key) on update cascade
);
create index service_class_prices_class_idx on service_class_prices (location_id, class_key);

-- Backfill 1: a tint package (category tint, tagged with a film of its location's catalog.tint_matrix) gets one cell per matrix row
-- of its film, from the guest range; the matrix's vehicle types map sedan -> compact_car, suv -> compact_suv, truck -> truck.
insert into service_class_prices (service_id, location_id, class_key, price_cents, max_cents)
select s.id, s.location_id, m.class_key, (p->>'guestMinCents')::int,
  case when (p->>'guestMaxCents')::int > (p->>'guestMinCents')::int then (p->>'guestMaxCents')::int end
from services s
join settings st on st.location_id = s.location_id and st.key = 'catalog.tint_matrix'
cross join lateral (
  select t.tag as film
  from unnest(s.tags) with ordinality as t(tag, i)
  where exists (select 1 from jsonb_array_elements(st.value->'films') f where f->>'key' = t.tag)
  order by t.i
  limit 1
) film
cross join lateral jsonb_array_elements(st.value->'prices') p
join (values ('sedan', 'compact_car'), ('suv', 'compact_suv'), ('truck', 'truck')) as m(vehicle, class_key)
  on m.vehicle = p->>'vehicle'
where s.category = 'tint' and p->>'film' = film.film
  and exists (select 1 from vehicle_classes vc where vc.location_id = s.location_id and vc.key = m.class_key)
on conflict do nothing;

-- Backfill 2: any other service with a member price gets today's guest price (its own, else the member price plus
-- catalog.guest_markup_pct, default 20, rounded half up to whole dollars: pricing.ts withMarkup) at the location's first size.
insert into service_class_prices (service_id, location_id, class_key, price_cents)
select s.id, s.location_id, first.key,
  coalesce(s.guest_price_cents,
    ((s.member_price_cents::bigint * (100 + coalesce((
      select (st.value #>> '{}')::int from settings st where st.location_id = s.location_id and st.key = 'catalog.guest_markup_pct'
    ), 20)) + 5000) / 10000 * 100)::int)
from services s
cross join lateral (
  select vc.key from vehicle_classes vc where vc.location_id = s.location_id order by vc.sort, vc.key limit 1
) first
where s.member_price_cents is not null
  and not exists (select 1 from service_class_prices x where x.service_id = s.id)
on conflict do nothing;

-- The tint films (key, label, VLT shades) the tint packages name by a tag, copied from the matrix (the setting catalog.tint_films).
insert into settings (location_id, key, value)
select st.location_id, 'catalog.tint_films', coalesce(st.value->'films', '[]'::jsonb)
from settings st
where st.key = 'catalog.tint_matrix'
on conflict do nothing;

-- A vehicle's size (no foreign key: vehicles carry no location, as appointments.categories), and who said so. The AI tool's
-- vehicle_type maps sedan_coupe -> compact_car, suv_crossover -> compact_suv, truck_van -> truck (source legacy: staff confirm it).
alter table vehicles
  add column vehicle_class text check (vehicle_class is null or vehicle_class ~ '^[a-z][a-z0-9_]{0,31}$'),
  add column vehicle_class_source text check (vehicle_class_source is null or vehicle_class_source in ('staff', 'client', 'ai', 'legacy')),
  add constraint vehicles_class_source_check check ((vehicle_class is null) = (vehicle_class_source is null));

update vehicles set
  vehicle_class = case vehicle_type when 'sedan_coupe' then 'compact_car' when 'suv_crossover' then 'compact_suv' else 'truck' end,
  vehicle_class_source = 'legacy'
where vehicle_type is not null;
