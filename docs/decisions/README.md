# Decisions (ADRs)

| # | Title |
|---|---|
| [0001](0001-stack.md) | Stack: Node 22, Fastify, Kysely, pg-boss, Postgres 15 |
| [0002](0002-money-and-time.md) | Money in integer cents; injectable time; business tz |
| [0003](0003-squarespace-boundary.md) | Squarespace stays the card processor; Oasis owns the ledger |
| [0004](0004-sms-gate.md) | SMS only, via SMS Gate on a tablet over Tailscale |
| [0005](0005-react-18-pages-router.md) | Dashboard: Next Pages Router + React 18.3.1 pin |
| [0006](0006-error-model-and-idempotency.md) | Error model (RFC 9457) and idempotency keys |
| [0007](0007-http-zod4-and-test-schemas.md) | HTTP schemas on Zod 4; per-worker schemas for integration tests |
| [0008](0008-sessions-and-csrf.md) | Sessions, CSRF and login throttling |
| [0009](0009-view-as.md) | Super Admin view-as semantics |
| [0010](0010-money-limit-storage.md) | Money limit storage (cents, explicit unlimited) and resolution |
| [0020](0020-domain-core-schema.md) | Domain core schema: location scoping, deferred foreign keys, bay-occupancy index |
| [0021](0021-checklist-task-ids.md) | Checklist tasks keep stable ids; the PUT diff rules |
| [0022](0022-closures-federal-holidays-emergency.md) | Closures, federal holidays, dayInfo and emergency closures |
| [0023](0023-vip-and-settings-data-rules.md) | VIP, arrival and settings data rules |
| [0030](0030-settings-http-contract.md) | Settings HTTP contract: versions, time forms, bundle filtering, VIP-by-name, idempotency |
| [0031](0031-emergency-over-http.md) | Emergency closing over HTTP: B38 guard, auto-reopen and sweep, events, crew alert |
| [0032](0032-settings-adapters-and-ports.md) | Settings adapters and ports: DB hours port, recording notifiers, ChecklistSync, jobs |
| [0033](0033-settings-oracle.md) | The original design as an automated oracle for Settings |
| [0040](0040-scheduling-ports-and-wiring.md) | Scheduling ports (invoices, messages, memberships) and wiring |
| [0041](0041-availability-engine.md) | Availability engine: capacity, VIP holds, overrides, same-day guarantee |
| [0042](0042-lifecycle-guards-and-bays.md) | Lifecycle guards, expectedStatus, bay choice and concurrency |
| [0043](0043-operations-read-models.md) | Operations read models: KPIs, alerts, windows, bay staff, calendar |
| [0044](0044-ops-oracle-and-parity-seed.md) | Operations oracle tests and the parity-ops seed |
| [0050](0050-payments-ledger-and-calc.md) | Payments: append-only ledger, invoice_calc in cents, status ladder, void |
| [0051](0051-payments-limits-approvals-settlement.md) | Payments: limits, approvals (self-approval, re-validation), settlement refund, refund by item |
| [0052](0052-payments-store-credit.md) | Payments: store-credit lots, FIFO allocation at apply time, expiry |
| [0053](0053-payments-card-money-under-squarespace.md) | Payments: card money awaiting Squarespace, brand-only labels, payment links |
| [0054](0054-payments-invoice-lifecycle.md) | Payments: invoice at booking, gap-free numbering, biz_date freeze, canceled statuses |
| [0055](0055-payments-reports-and-csv.md) | Payments: ranges, KPIs, chart, by-method, list, banner and CSV rules |
