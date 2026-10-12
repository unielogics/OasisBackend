-- What a visit was priced at (ADR 0170): the size it was booked at and, per line, the regular price at that size, the member % off
-- and how the price was found. Written from wave Q2 (the booking paths, the size change and the quote); until then every row is
-- 'legacy' (priced the old way) and the columns stay null. The ledger and invoice_calc_of do not change: the charge is still
-- price_cents, the size difference of a covered line is derived (line - covered).
--   price_basis  legacy (before sizes), class (the size's own price), unknown_class (no size known: the first size's price),
--                estimated (the size has no price: the starting price, "confirm price"), base (the service has no size prices)

alter table appointments
  add column vehicle_class text check (vehicle_class is null or vehicle_class ~ '^[a-z][a-z0-9_]{0,31}$'),
  add column vehicle_class_label text check (vehicle_class_label is null or length(vehicle_class_label) <= 40),
  -- staff confirmed the size at the shop ("Confirm size" badge until then)
  add column class_confirmed_at timestamptz,
  add column list_price_cents integer check (list_price_cents is null or list_price_cents >= 0),
  add column discount_bp integer check (discount_bp is null or discount_bp between 0 and 10000),
  add column price_basis text not null default 'legacy'
    check (price_basis in ('legacy', 'class', 'unknown_class', 'estimated', 'base'));

alter table appointment_addons
  add column list_price_cents integer check (list_price_cents is null or list_price_cents >= 0),
  add column discount_bp integer check (discount_bp is null or discount_bp between 0 and 10000),
  add column price_basis text not null default 'legacy'
    check (price_basis in ('legacy', 'class', 'unknown_class', 'estimated', 'base'));

alter table invoice_items
  add column list_cents integer check (list_cents is null or list_cents >= price_cents),
  add column discount_bp integer check (discount_bp is null or discount_bp between 0 and 10000),
  add column price_basis text not null default 'legacy'
    check (price_basis in ('legacy', 'class', 'unknown_class', 'estimated', 'base'));

alter table invoices
  add column vehicle_class_label text check (vehicle_class_label is null or length(vehicle_class_label) <= 40);
