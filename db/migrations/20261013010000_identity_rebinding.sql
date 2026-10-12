-- Stale-record re-binding (ADR 0160, section "W4c fixes"): proving control of a NUMBER (a texted code) is not proof of being the
-- client the shop had on file for it. What may end the stale-record rule is proof of being that client: their PIN, a staff action
-- or a membership payment matched to them. A party that verified only the number on a stale record gets a new client record; the
-- number moves to it and the old record keeps its history, loses the phone and is flagged for staff.

alter table customers
  -- the last time someone proved being this client (their PIN on a link page, staff confirming the number): activity for the
  -- stale-record rule, which a texted code never is
  add column identity_confirmed_at timestamptz,
  -- the number was moved to a new client because a party who verified only the number booked on this stale record (staff flag)
  add column phone_reassigned_at timestamptz,
  add column phone_reassigned_to uuid references customers(id) on delete set null;

alter table appointments
  -- created by a link page or the assistant for a session verified with this client's own PIN (the stale-record rule counts it)
  add column booked_with_pin boolean not null default false;

-- the PIN verifications recorded so far are such proof
update customers c set identity_confirmed_at = t.verified_at
  from (select customer_id, max(verified_at) as verified_at from phone_trust where verified_by = 'pin' group by customer_id) t
  where t.customer_id = c.id;
