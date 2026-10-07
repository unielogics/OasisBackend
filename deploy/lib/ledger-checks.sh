#!/usr/bin/env bash
# The ledger invariants, shared by restore-drill.sh (against a restored copy) and ledger-check.sh (against the live database).
# Source after common.sh. The caller defines: scalar SQL (prints one value from the database being checked), pass MSG, fail MSG.
# Everything here only reads. See docs/runbook.md, "Ledger mismatch".
# shellcheck shell=bash

ledger_invariants() {
  local bad guard over totals
  if [[ "$(scalar "select to_regclass('ledger_events') is not null")" != t ]]; then
    warn "there is no ledger_events table here; ledger invariants skipped"
    return 0
  fi

  bad=$(scalar "
    with e as (
      select invoice_id,
             coalesce(sum(amount_cents) filter (where type = 'pay'), 0) - coalesce(sum(amount_cents) filter (where type = 'void'), 0)
               + coalesce(sum(amount_cents) filter (where type = 'credit_apply'), 0) as paid,
             coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'done'), 0) as refunded
      from ledger_events group by invoice_id)
    select count(*) from invoice_calc c left join e on e.invoice_id = c.invoice_id
    where c.paid <> coalesce(e.paid, 0) or c.refunded <> coalesce(e.refunded, 0)")
  if [[ "$bad" == 0 ]]; then pass "ledger: paid and refunded of every invoice equal the sum of its events"; else fail "ledger: $bad invoice(s) where invoice_calc differs from the sum of ledger_events"; fi

  bad=$(scalar "
    select count(*) from invoice_calc c join invoices i on i.id = c.invoice_id
    where c.balance < 0
       or (i.canceled_at is null and c.balance <> greatest(0, c.total - c.paid))
       or (i.canceled_at is not null and c.balance <> 0)")
  if [[ "$bad" == 0 ]]; then pass "ledger: no negative balance, and balance = max(0, total - paid) on every invoice"; else fail "ledger: $bad invoice(s) with a wrong balance"; fi

  bad=$(scalar "select count(*) from (select seq from ledger_events group by seq having count(*) > 1) d")
  if [[ "$bad" == 0 ]]; then pass "ledger: event sequence numbers are unique"; else fail "ledger: $bad duplicated sequence number(s)"; fi

  bad=$(scalar "select count(*) from ledger_events e where not exists (select 1 from invoices i where i.id = e.invoice_id)")
  if [[ "$bad" == 0 ]]; then pass "ledger: every event belongs to an invoice"; else fail "ledger: $bad event(s) without an invoice"; fi

  guard=$(scalar "select count(*) from pg_trigger t where t.tgrelid = 'ledger_events'::regclass and t.tgname = 'ledger_events_guard' and not t.tgisinternal")
  if [[ "$guard" == 1 ]]; then pass "ledger: the append-only guard trigger is present"; else fail "ledger: the ledger_events_guard trigger is missing, so the ledger is not append-only"; fi

  over=$(scalar "select count(*) from invoice_calc where refunded > paid")
  [[ "$over" == 0 ]] || warn "ledger: $over invoice(s) refunded more than paid (Squarespace refunds made outside Oasis show up this way; review the external_refund alerts)"
  totals=$(scalar "select count(*) || ' events, ' || (select count(*) from invoices) || ' invoices, paid ' || coalesce((select sum(paid) from invoice_calc), 0) || ' cents, refunded ' || coalesce((select sum(refunded) from invoice_calc), 0) || ' cents' from ledger_events")
  log "ledger totals: $totals"
}
