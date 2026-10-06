// Who appears as a column in the staff view and can be assigned to a job. Derived, never hard-coded: an active employee
// of the location who holds the Crew role, or a custom role that grants jobs.status, or a per-person Allow of
// jobs.status, and no per-person Deny of it. Management, Accounting and Super Admin grant jobs.status incidentally and
// do not make someone a detailer.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { displayName, initials } from '../auth/context.js'
import '../people/schema.js'

export interface BayStaff {
  id: string
  first: string
  last: string
  /** "Marco R." */
  name: string
  initials: string
  title: string
  avatarColor: string | null
}

export async function listBayStaff(db: Executor, locationId: string): Promise<BayStaff[]> {
  const rows = await db
    .selectFrom('employees as e')
    .innerJoin('employee_locations as el', (j) =>
      j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', locationId),
    )
    .select(['e.id', 'e.first', 'e.last', 'e.title', 'e.avatar_color'])
    .where('e.status', '=', 'active')
    .where(
      sql<boolean>`not exists (
        select 1 from employee_permission_overrides o
        where o.employee_id = e.id and o.permission_key = 'jobs.status' and o.effect = 'deny')`,
    )
    .where(
      sql<boolean>`(
        exists (
          select 1 from employee_roles er join roles r on r.id = er.role_id
          where er.employee_id = e.id
            and (r.key = 'crew'
              or (r.is_custom and exists (
                select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_key = 'jobs.status'))))
        or exists (
          select 1 from employee_permission_overrides o
          where o.employee_id = e.id and o.permission_key = 'jobs.status' and o.effect = 'allow'))`,
    )
    .orderBy('e.created_at')
    .orderBy('e.id')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    first: r.first,
    last: r.last,
    name: displayName(r.first, r.last),
    initials: initials(r.first, r.last),
    title: r.title,
    avatarColor: r.avatar_color,
  }))
}
