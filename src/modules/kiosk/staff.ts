// Who the kiosk's employee picker lists (ADR 0180, plan open decision 1): every active or INVITED employee of the location with
// "Shows on the kiosk" on (crew may never accept their invite: they still tap their name). Bay staff first (the same rule as the
// staff view's columns, src/modules/scheduling/staff.ts), then by first name. And the check of a tapped employee (X-Oasis-Employee).
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { displayName, initials } from '../auth/context.js'
import './schema.js'

export interface KioskPerson {
  id: string
  /** "Marco R." */
  name: string
  first: string
  initials: string
  avatarColor: string | null
  title: string
  /** Holds the Crew role (or a custom role / exception granting jobs.status): a bay worker, listed first. */
  bayStaff: boolean
}

const BAY_STAFF = sql<boolean>`(
  not exists (
    select 1 from employee_permission_overrides o
    where o.employee_id = e.id and o.permission_key = 'jobs.status' and o.effect = 'deny')
  and (
    exists (
      select 1 from employee_roles er join roles r on r.id = er.role_id
      where er.employee_id = e.id
        and (r.key = 'crew'
          or (r.is_custom and exists (
            select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_key = 'jobs.status'))))
    or exists (
      select 1 from employee_permission_overrides o
      where o.employee_id = e.id and o.permission_key = 'jobs.status' and o.effect = 'allow')))`

export async function listKioskStaff(db: Executor, locationId: string): Promise<KioskPerson[]> {
  const rows = await db
    .selectFrom('employees as e')
    .innerJoin('employee_locations as el', (j) =>
      j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', locationId),
    )
    .select(['e.id', 'e.first', 'e.last', 'e.title', 'e.avatar_color', BAY_STAFF.as('bay_staff')])
    .where('e.status', 'in', ['active', 'invited'])
    .where('e.kiosk_listed', '=', true)
    .execute()
  return rows
    .map((r) => ({
      id: r.id,
      name: displayName(r.first, r.last),
      first: r.first.trim(),
      initials: initials(r.first, r.last),
      avatarColor: r.avatar_color,
      title: r.title,
      bayStaff: r.bay_staff === true,
    }))
    .sort(
      (a, b) =>
        Number(b.bayStaff) - Number(a.bayStaff) ||
        a.first.localeCompare(b.first, 'en', { sensitivity: 'base' }) ||
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
        a.id.localeCompare(b.id),
    )
}

/** The employee a kiosk request names, when they may act on that location's kiosk; else null. */
export async function findKioskActor(
  db: Executor,
  locationId: string,
  employeeId: string,
): Promise<{ id: string; first: string; last: string; name: string } | null> {
  const r = await db
    .selectFrom('employees as e')
    .innerJoin('employee_locations as el', (j) =>
      j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', locationId),
    )
    .select(['e.id', 'e.first', 'e.last'])
    .where('e.id', '=', employeeId)
    .where('e.status', 'in', ['active', 'invited'])
    .where('e.kiosk_listed', '=', true)
    .executeTakeFirst()
  return r ? { id: r.id, first: r.first, last: r.last, name: displayName(r.first, r.last) } : null
}
