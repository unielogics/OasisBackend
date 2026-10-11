-- One catalog in Settings for the website, bookings and the AI assistant (ADR 0160, design section 1 "Catalog").
-- Categories (Wash, Add-ons, Tint, Detail, Quote) with the website's colours; every service gains the website/AI fields
-- (public name, description, member and guest prices, VIP inclusion, quote-only, online visibility) and a category; every
-- appointment keeps the categories of what it holds (its package and live add-ons) so the board, KPIs and payments can split by
-- category; membership plans gain their monthly price, checkout URL and public label. Forward-only, like every migration here.

create table catalog_categories (
  location_id uuid not null references locations(id) on delete cascade,
  -- lowercase key the services, appointments and leads refer to (wash, addons, tint, detail, quote)
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  label text not null check (btrim(label) <> '' and length(label) <= 40),
  -- #RRGGBB, shown on the dashboard chips and the website
  colour text not null check (colour ~ '^#[0-9A-Fa-f]{6}$'),
  sort integer not null default 0,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  primary key (location_id, key)
);

-- The defaults, in the website palette (accent #1FB6FF, its light tint #7FD6FF, ok #2EE59D, amber #FFB547, ink3 #8C97A1), for every
-- location that exists now; new locations get them from ensureDomainDefaults (src/modules/settings/defaults.ts).
insert into catalog_categories (location_id, key, label, colour, sort)
select l.id, c.key, c.label, c.colour, c.sort
from locations l
cross join (values
  ('wash', 'Wash', '#1FB6FF', 10),
  ('addons', 'Add-ons', '#7FD6FF', 20),
  ('tint', 'Tint', '#2EE59D', 30),
  ('detail', 'Detail', '#FFB547', 40),
  ('quote', 'Quote', '#8C97A1', 50)
) as c(key, label, colour, sort)
on conflict do nothing;

alter table services
  add column category text,
  add column public_name text check (public_name is null or (btrim(public_name) <> '' and length(public_name) <= 80)),
  add column description text check (description is null or length(description) <= 1000),
  -- website prices: what a member and a guest pay (null = the plain price_cents); guest defaults to member x catalog.guest_markup_pct
  add column member_price_cents integer check (member_price_cents is null or member_price_cents >= 0),
  add column guest_price_cents integer check (guest_price_cents is null or guest_price_cents >= 0),
  -- what VIP members get: included, an allowance (described by vip_note, e.g. "1 per month"), or nothing
  add column vip_inclusion text not null default 'none' check (vip_inclusion in ('included', 'allowance', 'none')),
  add column vip_note text check (vip_note is null or (btrim(vip_note) <> '' and length(vip_note) <= 200)),
  -- shown with "ask for a quote" instead of a price; never booked online
  add column quote_only boolean not null default false,
  -- listed on the website and offered by the assistant (true keeps today's behaviour: every active service is public)
  add column visible_online boolean not null default true,
  add constraint services_category_fkey foreign key (location_id, category)
    references catalog_categories (location_id, key) on update cascade;
create index services_category_idx on services (location_id, category) where active;

-- Every service has a category. The rule, for the backfill and for a new row inserted without one (the catalog API names it
-- explicitly from wave 2 on): add-ons are add-ons; a package tagged tint is tint; detail, ceramic, exotic and executive are details
-- (Executive Detail and Executive Detail + Ceramic are details, not washes); any other package is a wash.
create function catalog_default_category(p_kind text, p_tags text[]) returns text
language sql immutable as $$
  select case
    when p_kind = 'addon' then 'addons'
    when p_tags && array['tint'] then 'tint'
    when p_tags && array['detail', 'ceramic', 'exotic', 'executive'] then 'detail'
    else 'wash'
  end
$$;

-- The defaults (key, label, colour, sort) the migration seeds and ensureCatalogCategories inserts; the insert trigger below adds the
-- one a new service needs when its location lacks it (a location created without ensureDomainDefaults).
create function services_default_category() returns trigger
language plpgsql as $$
begin
  if new.category is null then
    new.category := catalog_default_category(new.kind, new.tags);
    insert into catalog_categories (location_id, key, label, colour, sort)
    select new.location_id, c.key, c.label, c.colour, c.sort
    from (values
      ('wash', 'Wash', '#1FB6FF', 10),
      ('addons', 'Add-ons', '#7FD6FF', 20),
      ('tint', 'Tint', '#2EE59D', 30),
      ('detail', 'Detail', '#FFB547', 40)
    ) as c(key, label, colour, sort)
    where c.key = new.category
    on conflict do nothing;
  end if;
  return new;
end
$$;

update services set category = catalog_default_category(kind, tags) where category is null;
alter table services alter column category set not null;
create trigger services_default_category before insert on services
  for each row execute function services_default_category();

-- The categories an appointment holds (its package and live add-ons), in category order; maintained on book, edit and add-on
-- change from wave 2 on. Several entries make a "mixed" visit.
alter table appointments
  add column categories text[] not null default '{}'
    check (array_position(categories, null) is null and cardinality(categories) <= 10);
create index appointments_categories_idx on appointments using gin (categories);

update appointments a set categories = coalesce((
  select array_agg(x.key order by x.sort, x.key)
  from (
    select distinct cc.key, cc.sort
    from services s
    join catalog_categories cc on cc.location_id = s.location_id and cc.key = s.category
    where s.id = a.service_id
       or s.id in (select aa.service_id from appointment_addons aa where aa.appointment_id = a.id and aa.removed_at is null)
  ) x
), '{}');

alter table membership_plans
  add column monthly_price_cents integer check (monthly_price_cents is null or monthly_price_cents >= 0),
  -- the plan's Squarespace subscription checkout (https, squarespace.com only; the membership link redirects there)
  add column checkout_url text check (
    checkout_url is null
    or (checkout_url ~ '^https://([a-z0-9-]+\.)*squarespace\.com(/[^[:space:]]*)?$' and length(checkout_url) <= 2048)
  ),
  -- the name the website and the assistant use (Gold, VIP)
  add column public_label text check (public_label is null or (btrim(public_label) <> '' and length(public_label) <= 40));
