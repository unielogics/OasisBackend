-- Review Q4 re-verification and the Square sandbox end-to-end run (ADR 0170 and ADR 0171, "Wave Q4 fix notes").
--
-- SANDBOX-F1: a tier's inclusions apply by themselves when a covered visit is completed (plan decision 2; the column default is
-- already true). The default tiers' inclusions were created with auto_apply false (ensurePlans, and the copy of plan_credit_rules in
-- 20261014100100); the ones nobody has edited are turned on. Edited means: the tier saved in Settings (audit catalog.tier.create or
-- catalog.tier.update on its key) or the inclusion's own auto-apply switched (audit membership.rule.update). Production has no
-- members yet, so no visit changes.
update membership_inclusions i
set auto_apply = true, updated_at = app_now()
where not i.auto_apply
  and not exists (select 1 from audit_log a where a.action = 'membership.rule.update' and a.entity_id = i.id::text)
  and not exists (
    select 1 from audit_log a join membership_plans p on p.id = i.plan_id
    where a.location_id = p.location_id
      and a.action in ('catalog.tier.create', 'catalog.tier.update')
      and a.entity_id in (p.key, p.legacy_key)
  );

-- SQ-SEM-5-R1: how many times processing a logged webhook or event failed. The Square catch-up backs a failed row off by it (10
-- minutes after the last try, doubling, at most a day) instead of trying every failed row every 10 minutes for 28 days.
alter table webhook_log add column attempts integer not null default 0 check (attempts >= 0);
update webhook_log set attempts = 1 where status = 'failed';

-- SANDBOX-F2: the connection point, the first successful Test connection of a stack that had not read Square's events yet. A counter
-- payment Square made before it is the shop's history (ignored, "before connection"), never queued nor alerted.
alter table square_state add column connected_at timestamptz;
