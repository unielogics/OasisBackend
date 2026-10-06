// Seed profile "people": the five roles with the Settings design's grants and limits, and the seven design employees
// (schedules, skills, pay data, Sofia's sched.override exception, Kevin still invited). Idempotent: roles are matched by
// key and employees by email, existing rows are left alone.
// No passwords are seeded. Only when SEED_DEV_PASSWORD is set (never in production) do the active employees get a login
// with that password, for local development and the demo profile.
import { PasswordHasher } from '../../src/modules/auth/password.js'
import { ensureDefaultRoles, bumpRbacVersion } from '../../src/modules/rbac/repository.js'
import { normalizePhone } from '../../src/platform/phone.js'
import type { SeedContext, SeedProfile } from './index.js'

/** Avatar colours by list index mod 7 (Settings design). */
const AVATAR_COLORS = ['#0E7A63', '#2563EB', '#7A3B8A', '#C2740B', '#0D9488', '#B45309', '#6B7280']

/** The design's sch(days): weekdays 0=Sun..6=Sat; Sunday 9-3, Saturday 8-5, other days 8-6 (matches the business hours). */
export function sch(
  days: readonly number[],
): Array<{ weekday: number; on: boolean; fromMin: number; toMin: number }> {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    on: days.includes(weekday),
    fromMin: weekday === 0 ? 9 * 60 : 8 * 60,
    toMin: weekday === 0 ? 15 * 60 : weekday === 6 ? 17 * 60 : 18 * 60,
  }))
}

const MON_SAT = [1, 2, 3, 4, 5, 6]

interface SeedEmployee {
  first: string
  last: string
  title: string
  phone: string
  roles: string[]
  status: 'active' | 'invited'
  type: 'full_time' | 'part_time' | 'contractor'
  pay: 'hourly' | 'commission' | 'salary'
  rate: string
  skills: string[]
  days: number[]
  overrides?: Record<string, 'allow' | 'deny'>
}

export const SEED_EMPLOYEES: SeedEmployee[] = [
  {
    first: 'Amara',
    last: 'Okoye',
    title: 'Owner',
    phone: '(305) 555-0101',
    roles: ['super'],
    status: 'active',
    type: 'full_time',
    pay: 'salary',
    rate: '',
    skills: ['Exotic vehicles'],
    days: MON_SAT,
  },
  {
    first: 'Rafael',
    last: 'Mendes',
    title: 'General Manager',
    phone: '(305) 555-0140',
    roles: ['mgmt', 'acct'],
    status: 'active',
    type: 'full_time',
    pay: 'salary',
    rate: '',
    skills: [],
    days: MON_SAT,
  },
  {
    first: 'Marco',
    last: 'Ruiz',
    title: 'Lead Detailer',
    phone: '(786) 555-0172',
    roles: ['crew'],
    status: 'active',
    type: 'full_time',
    pay: 'commission',
    rate: '30',
    skills: ['Paint correction', 'Ceramic coating', 'Exotic vehicles'],
    days: MON_SAT,
  },
  {
    first: 'Lena',
    last: 'Kim',
    title: 'Detailer',
    phone: '(305) 555-0119',
    roles: ['crew'],
    status: 'active',
    type: 'full_time',
    pay: 'hourly',
    rate: '22',
    skills: ['Interior detailing'],
    days: [0, 2, 3, 4, 5, 6],
  },
  {
    first: 'Sofia',
    last: 'Duarte',
    title: 'Front Desk',
    phone: '(786) 555-0133',
    roles: ['support', 'crew'],
    status: 'active',
    type: 'full_time',
    pay: 'hourly',
    rate: '21',
    skills: ['Front desk'],
    days: MON_SAT,
    overrides: { 'sched.override': 'allow' },
  },
  {
    first: 'Daniel',
    last: 'Price',
    title: 'Bookkeeper',
    phone: '(305) 555-0188',
    roles: ['acct'],
    status: 'active',
    type: 'part_time',
    pay: 'hourly',
    rate: '34',
    skills: [],
    days: [1, 3, 5],
  },
  {
    first: 'Kevin',
    last: 'Tran',
    title: 'Detailer',
    phone: '(786) 555-0151',
    roles: ['crew'],
    status: 'invited',
    type: 'full_time',
    pay: 'hourly',
    rate: '19',
    skills: [],
    days: [1, 2, 3, 4, 5],
  },
]

export const seedEmail = (e: Pick<SeedEmployee, 'first'>): string =>
  `${e.first.toLowerCase()}@oasisautospa.com`

export async function seedPeople(ctx: SeedContext): Promise<void> {
  const { tx, newId, clock, location, log } = ctx
  const roleIds = await ensureDefaultRoles(tx, newId)
  const devPassword = process.env.SEED_DEV_PASSWORD
  if (devPassword && process.env.NODE_ENV === 'production')
    throw new Error('SEED_DEV_PASSWORD must not be used in production')
  const hasher = devPassword ? new PasswordHasher() : null
  const now = clock.now()
  let created = 0

  for (const [i, e] of SEED_EMPLOYEES.entries()) {
    const email = seedEmail(e)
    const existing = await tx
      .selectFrom('employees')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst()
    let id = existing?.id
    if (!id) {
      id = newId()
      created++
      await tx
        .insertInto('employees')
        .values({
          id,
          first: e.first,
          last: e.last,
          title: e.title,
          phone: e.phone,
          phone_e164: normalizePhone(e.phone),
          email,
          status: e.status,
          employment_type: e.type,
          pay_type: e.pay,
          rate_text: e.rate,
          skills: e.skills,
          avatar_color: AVATAR_COLORS[i % AVATAR_COLORS.length]!,
          created_at: new Date(now.getTime() + i),
          updated_at: now,
        })
        .execute()
      await tx
        .insertInto('employee_locations')
        .values({ employee_id: id, location_id: location.id })
        .execute()
      await tx
        .insertInto('employee_schedules')
        .values(
          sch(e.days).map((s) => ({
            employee_id: id!,
            weekday: s.weekday,
            is_on: s.on,
            from_min: s.fromMin,
            to_min: s.toMin,
          })),
        )
        .execute()
      await tx
        .insertInto('employee_roles')
        .values(e.roles.map((r) => ({ employee_id: id!, role_id: roleIds.get(r)! })))
        .execute()
      const ov = Object.entries(e.overrides ?? {}).map(([permission_key, effect]) => ({
        employee_id: id!,
        permission_key,
        effect,
      }))
      if (ov.length) await tx.insertInto('employee_permission_overrides').values(ov).execute()
    }
    if (hasher && e.status === 'active') {
      const user = await tx.selectFrom('users').select('id').where('employee_id', '=', id).executeTakeFirst()
      if (!user) {
        await tx
          .insertInto('users')
          .values({
            id: newId(),
            employee_id: id,
            email,
            password_hash: await hasher.hash(devPassword!),
            last_login_at: null,
          })
          .execute()
      }
    }
  }
  await bumpRbacVersion(tx)
  log(
    `people: ${created} employee(s) created, ${SEED_EMPLOYEES.length - created} already present${hasher ? ', dev logins ensured' : ''}`,
  )
}

export const peopleProfile: SeedProfile = {
  description:
    'Roles and permission grants, and the 7 design employees (set SEED_DEV_PASSWORD for dev logins)',
  run: seedPeople,
}
