-- ADR 0174 (the AI assistant: knowledge, PDFs, practice, limits): Settings → Oasis AI gets its own permission, set.assistant,
-- "Oasis AI assistant". It is appended LAST to the catalog (permissions.sort is unique and ensurePermissionCatalog inserts with
-- `on conflict (key) do nothing`, so a new key can only take the next sort, 28). Saving the assistant section, unmasking its
-- allowlist and every knowledge, document, practice and review route need it.
--
-- Nobody loses access: every role that holds set.hours today (the permission the section used until now) is granted
-- set.assistant, and a person's own Allow or Deny exception for set.hours is copied to set.assistant, so who may edit the
-- assistant is exactly who could before. The owner can take it away from a role afterwards (Team → Roles).
insert into permissions (key, module, label, has_limit, sort)
values ('set.assistant', 'Settings', 'Oasis AI assistant', false, 28)
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_key)
select rp.role_id, 'set.assistant' from role_permissions rp where rp.permission_key = 'set.hours'
on conflict do nothing;

insert into employee_permission_overrides (employee_id, permission_key, effect)
select o.employee_id, 'set.assistant', o.effect from employee_permission_overrides o where o.permission_key = 'set.hours'
on conflict do nothing;
