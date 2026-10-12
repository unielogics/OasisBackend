-- Editable membership tiers (ADR 0170, plan decisions 2, 3 and 8). The four fixed plan keys become slugs: premium is renamed gold
-- and executive vip (the old key kept in legacy_key, which resolves old Squarespace product names), and the two foreign keys that
-- use the key (client_links, membership_checkouts) follow by their on update cascade. A tier gains its member % off (0 at migration,
-- so no charge changes), whether it is sold online, whether it gives the VIP slot rules, a car cap and a price version. Its monthly
-- price lives per vehicle size in membership_tier_prices (append-only: a price edit supersedes the current row; each row becomes one
-- Square plan variation in wave Q3b). What a tier includes moves from the tag-based plan_credit_rules (kept, read only, as
-- history) to membership_inclusions, which name the services they cover. A membership is priced at a size (plan_class, required)
-- and may cover a household (membership_household, written from wave Q2).

-- ---- tiers ----------------------------------------------------------------------------------------------------------------------

alter table membership_plans drop constraint membership_plans_key_check;
alter table membership_plans
  add constraint membership_plans_key_check check (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- the member % off every line the membership does not cover, in basis points (1000 = 10%); rounded to whole dollars
  add column member_discount_bp integer not null default 0 check (member_discount_bp between 0 and 10000),
  -- sold on the website and by the assistant
  add column public boolean not null default false,
  -- members get the VIP slot rules (held slots, the VIP booking window)
  add column vip_booking boolean not null default false,
  -- how many cars a member may record at join (information only; coverage is by customer)
  add column max_vehicles integer check (max_vehicles is null or max_vehicles between 1 and 20),
  -- bumped by every tier price save (wave Q3b moves members between price versions)
  add column price_version integer not null default 1 check (price_version >= 1),
  add column square_plan_id text check (square_plan_id is null or length(square_plan_id) <= 64),
  -- the old fixed key (premium, executive) that Squarespace product maps and old links may still name
  add column legacy_key text check (legacy_key is null or legacy_key ~ '^[a-z][a-z0-9_]{0,31}$');
create unique index uq_membership_plans_legacy_key on membership_plans (location_id, legacy_key) where legacy_key is not null;

update membership_plans set key = 'gold', legacy_key = 'premium', name = coalesce(public_label, 'Gold'), public = true
where key = 'premium';
update membership_plans set key = 'vip', legacy_key = 'executive', name = coalesce(public_label, 'VIP'), public = true,
  vip_booking = true
where key = 'executive';
-- the two the website never sold stay for the members who hold them, off otherwise
update membership_plans p set active = exists (
  select 1 from memberships m where m.plan_id = p.id and m.status in ('pending', 'active', 'past_due', 'paused')
)
where p.key in ('essential', 'exotic');

-- ---- tier prices by size ----------------------------------------------------------------------------------------------------

create table membership_tier_prices (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  plan_id uuid not null references membership_plans(id) on delete cascade,
  class_key text not null,
  monthly_cents integer not null check (monthly_cents between 0 and 10000000),
  effective_from timestamptz not null default app_now(),
  -- set when a later save replaces this price (null = the current price of this tier and size)
  superseded_at timestamptz,
  -- membership_plans.price_version when the row was written
  price_version integer not null check (price_version >= 1),
  -- the Square plan variation this price is billed as (wave Q3b)
  square_variation_id text check (square_variation_id is null or length(square_variation_id) <= 64),
  square_state text not null default 'pending' check (square_state in ('pending', 'synced', 'failed')),
  square_synced_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default app_now(),
  check (superseded_at is null or superseded_at >= effective_from),
  constraint membership_tier_prices_class_fkey foreign key (location_id, class_key)
    references vehicle_classes (location_id, key) on update cascade
);
create unique index uq_membership_tier_prices_current on membership_tier_prices (plan_id, class_key) where superseded_at is null;
create index membership_tier_prices_plan_idx on membership_tier_prices (plan_id, class_key, effective_from);

-- Append-only: no deletes (unless the tier itself is deleted: the cascade), and an update may only supersede the row or move the
-- Square fields.
create function membership_tier_prices_guard() returns trigger
language plpgsql as $$
declare
  mutable text[] := array['superseded_at', 'square_variation_id', 'square_state', 'square_synced_at'];
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from membership_plans p where p.id = old.plan_id) then
      raise exception 'membership_tier_prices is append-only: rows cannot be deleted' using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'membership_tier_prices is append-only: only superseded_at and the Square fields can change'
      using errcode = 'restrict_violation';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'membership_tier_prices: a superseded price stays superseded' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger membership_tier_prices_guard before update or delete on membership_tier_prices
  for each row execute function membership_tier_prices_guard();

-- Backfill: today's monthly price becomes the price at the location's first size.
insert into membership_tier_prices (id, location_id, plan_id, class_key, monthly_cents, price_version)
select gen_random_uuid(), p.location_id, p.id, first.key, p.monthly_price_cents, p.price_version
from membership_plans p
cross join lateral (
  select vc.key from vehicle_classes vc where vc.location_id = p.location_id order by vc.sort, vc.key limit 1
) first
where p.monthly_price_cents is not null;

-- ---- inclusions ---------------------------------------------------------------------------------------------------------------

-- What a tier includes: per_cycle (per_cycle visits a billing cycle, null = unlimited) or every_visit (an add-on on every visit
-- while the membership is active). auto_apply: completing a covered visit applies it by itself.
create table membership_inclusions (
  id uuid primary key,
  plan_id uuid not null references membership_plans(id) on delete cascade,
  label text not null check (btrim(label) <> '' and length(label) <= 80),
  mode text not null default 'per_cycle' check (mode in ('per_cycle', 'every_visit')),
  per_cycle integer check (per_cycle is null or per_cycle between 1 and 100),
  auto_apply boolean not null default true,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (mode = 'per_cycle' or per_cycle is null)
);
create index membership_inclusions_plan_idx on membership_inclusions (plan_id, sort);

create table membership_inclusion_services (
  inclusion_id uuid not null references membership_inclusions(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  primary key (inclusion_id, service_id)
);
create index membership_inclusion_services_service_idx on membership_inclusion_services (service_id);

-- Backfill: every credit rule becomes an inclusion with the same id (so the credit events keep pointing at it), covering the
-- services its tags cover today (the SQL form of plans.ts ruleCovers: any include tag, no exclude tag).
insert into membership_inclusions (id, plan_id, label, mode, per_cycle, auto_apply, sort, created_at)
select r.id, r.plan_id, left(r.label, 80), 'per_cycle', r.per_cycle, r.auto_apply, r.sort, r.created_at
from plan_credit_rules r;

insert into membership_inclusion_services (inclusion_id, service_id)
select r.id, s.id
from plan_credit_rules r
join membership_plans p on p.id = r.plan_id
join services s on s.location_id = p.location_id
where s.tags && r.include_tags and not (s.tags && r.exclude_tags)
on conflict do nothing;

-- ---- the credit ledger ----------------------------------------------------------------------------------------------------------

alter table membership_credit_events
  add column inclusion_id uuid references membership_inclusions(id) on delete set null,
  add column service_id uuid references services(id),
  -- the regular price of the covered line, the amount covered (min(price at the visit size, price at the plan size)) and both sizes
  add column line_cents integer check (line_cents is null or line_cents >= 0),
  add column covered_cents integer check (covered_cents is null or covered_cents >= 0),
  add column plan_class text check (plan_class is null or plan_class ~ '^[a-z][a-z0-9_]{0,31}$'),
  add column visit_class text check (visit_class is null or visit_class ~ '^[a-z][a-z0-9_]{0,31}$');
update membership_credit_events set inclusion_id = rule_id where rule_id is not null;

-- One redeem per appointment and inclusion (a wash and each included add-on on one visit); the service still redeems one per visit
-- until wave Q2 settles every covered line.
drop index uq_credit_redeem_appointment;
create unique index uq_credit_redeem_appointment on membership_credit_events (appointment_id, coalesce(inclusion_id, rule_id))
  where kind = 'redeem' and appointment_id is not null;

-- ---- memberships: the plan size and the price billed ---------------------------------------------------------------------------

alter table memberships
  add column plan_class text,
  add column tier_price_id uuid references membership_tier_prices(id);

-- A membership is priced at a size. Until every path names one (wave Q2), a membership written without it gets its location's
-- smallest active size; a location without sizes gets the defaults first (as services_default_category does for categories).
create function memberships_default_plan_class() returns trigger
language plpgsql as $$
begin
  if new.plan_class is null then
    insert into vehicle_classes (location_id, key, label, sort)
    select new.location_id, c.key, c.label, c.sort
    from (values
      ('compact_car', 'Compact car', 10),
      ('large_car', 'Large car', 20),
      ('compact_suv', 'Compact SUV', 30),
      ('large_suv', 'Large SUV', 40),
      ('truck', 'Truck', 50)
    ) as c(key, label, sort)
    where not exists (select 1 from vehicle_classes vc where vc.location_id = new.location_id)
    on conflict do nothing;
    select vc.key into new.plan_class
    from vehicle_classes vc
    where vc.location_id = new.location_id
    order by vc.active desc, vc.sort, vc.key
    limit 1;
  end if;
  return new;
end $$;

update memberships m set plan_class = (
  select vc.key from vehicle_classes vc where vc.location_id = m.location_id order by vc.active desc, vc.sort, vc.key limit 1
)
where plan_class is null;
alter table memberships
  alter column plan_class set not null,
  add constraint memberships_plan_class_fkey foreign key (location_id, plan_class)
    references vehicle_classes (location_id, key) on update cascade;
create trigger memberships_default_plan_class before insert on memberships
  for each row execute function memberships_default_plan_class();

-- ---- households -------------------------------------------------------------------------------------------------------------

-- The other customers a membership covers (the holder is memberships.customer_id). A customer is in at most one live household.
create table membership_household (
  id uuid primary key,
  membership_id uuid not null references memberships(id) on delete cascade,
  customer_id uuid not null references customers(id),
  added_at timestamptz not null default app_now(),
  added_by uuid,
  removed_at timestamptz,
  check (removed_at is null or removed_at >= added_at)
);
create unique index uq_membership_household_customer_live on membership_household (customer_id) where removed_at is null;
create index membership_household_membership_idx on membership_household (membership_id);

-- ---- checkouts ----------------------------------------------------------------------------------------------------------------

alter table membership_checkouts
  add column plan_class text check (plan_class is null or plan_class ~ '^[a-z][a-z0-9_]{0,31}$');
