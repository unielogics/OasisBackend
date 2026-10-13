-- Sales tax precision and Square's rounding (ADR 0173). New Jersey's 6.625% is 662.5 basis points, which the integer tax.rate_bp
-- and invoices.tax_bp could not hold, and Square rounds an order's tax half to even where Oasis rounded half-up (sandbox check
-- SQR-18: CalculateOrder rounds the tax ONCE on the order's taxable subtotal, half to even, for ad-hoc and catalog lines alike).
--
-- * Rates are kept in thousandths of a percent ("dbp", tenths of a basis point): 7000 = 7%, 6625 = 6.625%, 0 to 100000.
-- * invoices.tax_dbp replaces invoices.tax_bp (every existing row: tax_bp x 10, the same rate).
-- * invoices.tax_rounding: 'half_up' on every invoice that exists now (their numbers never change). A new invoice takes the
--   location's setting tax.rounding (the gateway writes it): 'half_up' by default, so 7% invoices are made exactly as before;
--   'half_even' (Square's rule) once the rollout switches it with 6.625%. The column default is 'half_up', the setting's default.
-- * The setting tax.rate_bp becomes tax.rate_dbp (a stored value is carried over x 10, version kept; the default stays 7%).
-- * invoice_calc_of computes the tax with sales_tax_cents (the SQL twin of salesTaxCents in src/platform/money.ts) and the net with
--   the dbp rate; with tax_rounding 'half_up' and tax_dbp = tax_bp x 10 every column is the same as before.

create function sales_tax_cents(p_sub bigint, p_dbp integer, p_rounding text)
returns bigint
language sql immutable strict as $$
  select case
    when p_rounding = 'half_even' then
      (p_sub * p_dbp) / 100000
        + case
            when 2 * ((p_sub * p_dbp) % 100000) > 100000 then 1
            when 2 * ((p_sub * p_dbp) % 100000) = 100000 and ((p_sub * p_dbp) / 100000) % 2 = 1 then 1
            else 0
          end
    else (p_sub * p_dbp + 50000) / 100000
  end
$$;
comment on function sales_tax_cents(bigint, integer, text) is
  'Tax of a non-negative subtotal at a rate in thousandths of a percent, rounded once: half_even (Square, ADR 0173) or half_up.';

alter table invoices add column tax_dbp integer;
update invoices set tax_dbp = tax_bp * 10;
alter table invoices alter column tax_dbp set not null;
alter table invoices add constraint invoices_tax_dbp_check check (tax_dbp between 0 and 100000);
alter table invoices add column tax_rounding text not null default 'half_up'
  constraint invoices_tax_rounding_check check (tax_rounding in ('half_up', 'half_even'));

create or replace function invoice_calc_of(p_invoice uuid)
returns table (
  invoice_id uuid, items bigint, adj bigint, sub bigint, tax bigint, tip bigint, total bigint,
  paid_orig bigint, credit_applied bigint, paid bigint, refunded bigint, ref_orig bigint,
  pending_amt bigint, pending_n bigint, issued bigint, balance bigint, refundable bigint, to_orig_max bigint,
  net bigint, overpaid bigint, status text
)
language sql stable as $$
  with i as (
    select id, tax_dbp, tax_rounding, tip_cents, canceled_at from invoices where id = p_invoice
  ),
  it as (
    select coalesce(sum(price_cents), 0)::bigint as items from invoice_items where invoice_id = p_invoice
  ),
  e as (
    select
      coalesce(sum(amount_cents) filter (where type = 'adjust'), 0)::bigint as adj,
      (coalesce(sum(amount_cents) filter (where type = 'pay'), 0)
        - coalesce(sum(amount_cents) filter (where type = 'void'), 0))::bigint as paid_orig,
      coalesce(sum(amount_cents) filter (where type = 'credit_apply'), 0)::bigint as credit_applied,
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'done' and processor_state <> 'failed'), 0)::bigint
        as refunded,
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'done' and processor_state <> 'failed'
        and dest <> 'credit'), 0)::bigint as ref_orig,
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'pending'), 0)::bigint as pending_amt,
      count(*) filter (where type = 'refund' and status = 'pending')::bigint as pending_n,
      coalesce(sum(amount_cents) filter (where type = 'credit_issue'), 0)::bigint as issued
    from ledger_events where invoice_id = p_invoice
  ),
  b as (
    select i.id as invoice_id, i.tax_dbp, i.tax_rounding, i.tip_cents::bigint as tip, i.canceled_at,
      it.items, e.adj, greatest(it.items + e.adj, 0) as sub,
      e.paid_orig, e.credit_applied, e.paid_orig + e.credit_applied as paid,
      e.refunded, e.ref_orig, e.pending_amt, e.pending_n, e.issued
    from i cross join it cross join e
  ),
  c as (
    select b.*, sales_tax_cents(b.sub, b.tax_dbp, b.tax_rounding) as tax from b
  ),
  d as (
    select c.*, c.sub + c.tax + c.tip as total from c
  ),
  f as (
    select d.*, case when d.canceled_at is not null then 0 else greatest(0, d.total - d.paid) end as balance from d
  )
  select f.invoice_id, f.items, f.adj, f.sub, f.tax, f.tip, f.total,
    f.paid_orig, f.credit_applied, f.paid, f.refunded, f.ref_orig,
    f.pending_amt, f.pending_n, f.issued, f.balance,
    greatest(0, f.paid - f.refunded - f.pending_amt) as refundable,
    greatest(0, f.paid_orig - f.ref_orig) as to_orig_max,
    f.items + f.adj - ((f.refunded * 100000 + (100000 + f.tax_dbp) / 2) / (100000 + f.tax_dbp)) as net,
    greatest(0, f.paid - f.refunded - f.total) as overpaid,
    case
      when f.canceled_at is not null and f.paid = 0 and f.refunded = 0 then 'canceled'
      when f.canceled_at is not null and f.refunded >= f.paid then 'canceled_refunded'
      when f.canceled_at is not null then 'canceled_kept'
      when f.refunded > 0 and f.refunded >= f.paid - 1 then 'refunded'
      when f.paid = 0 then 'unpaid'
      when f.balance > 0 then 'partially_paid'
      when f.refunded > 0 then 'partially_refunded'
      else 'paid'
    end as status
  from f
$$;

alter table invoices drop column tax_bp;

-- the location's rate: tax.rate_bp (integer basis points) becomes tax.rate_dbp (thousandths of a percent)
insert into settings (location_id, key, value, version, updated_by, updated_at)
  select location_id, 'tax.rate_dbp', to_jsonb((value #>> '{}')::integer * 10), version, updated_by, updated_at
  from settings where key = 'tax.rate_bp' and jsonb_typeof(value) = 'number'
  on conflict (location_id, key) do nothing;
delete from settings where key = 'tax.rate_bp';
