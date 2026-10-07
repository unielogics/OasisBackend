-- Membership gaps (b6 gap 3a): a credit rule can apply itself when a covered visit is completed. Off by default; the member's own
-- memberships.auto_apply flag is the other switch (either is enough). The credit ledger needs no change: 'redeem', 'restore' and
-- 'protect' events already exist (ADR 0073); ADR 0084 pins their meaning for the emergency closure.

alter table plan_credit_rules add column auto_apply boolean not null default false;
