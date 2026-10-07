// Adversarial review (rv/sec), held control: no GET route shows a customer's or colleague's phone or email to a person who
// holds every permission except cli.contact and team.edit. Walks the route registry, so a new read route is covered the
// moment it exists.
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { PERMISSION_KEYS } from '../../src/modules/rbac/catalog.js'
import { useHarness } from '../auth/harness.js'

const h = useHarness()

const digits = (s: string): string => s.replace(/\D/g, '')
const forms = (n: string): string[] => [
  n,
  `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`,
  `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`,
  `+1${n}`,
  `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6)}`,
]

describe('contact values never leave a GET route without cli.contact (or team.edit for colleagues)', () => {
  it('walks every read route over the ops and payments parity data', async () => {
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'parity-ops' })
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'parity-pay' })
    const db = h.t.db
    const secrets = new Set<string>()
    for (const c of await db
      .selectFrom('customers')
      .select(['phone_display', 'phone_e164', 'email'])
      .execute())
      for (const v of [c.phone_display, c.phone_e164, c.email]) if (v) secrets.add(v)
    for (const e of await db.selectFrom('employees').select(['phone', 'phone_e164', 'email']).execute())
      for (const v of [e.phone, e.phone_e164, e.email]) if (v) secrets.add(v)
    const national = new Set(
      [...secrets].filter((s) => !s.includes('@') && digits(s).length >= 10).map((s) => digits(s).slice(-10)),
    )
    const needles = [...[...national].flatMap(forms), ...[...secrets].filter((s) => s.includes('@'))]
    expect(needles.length).toBeGreaterThan(100)

    const { session } = await h.userWithPermissions(
      PERMISSION_KEYS.filter((k) => k !== 'cli.contact' && k !== 'team.edit'),
      'sweep@example.test',
    )
    const take = async (table: 'appointments' | 'invoices' | 'customers' | 'employees' | 'roles') =>
      (await db.selectFrom(table).select('id').limit(3).execute()).map((r) => r.id as string)
    const ids = [
      ...(await take('appointments')),
      ...(await take('invoices')),
      ...(await take('customers')),
      ...(await take('employees')),
      ...(await take('roles')),
    ]
    const query =
      '?date=2026-06-13&from=2026-06-01&to=2026-06-30&range=today&limit=50&q=a&month=2026-06&state=all&filter=all'

    const leaks: string[] = []
    let ok = 0
    for (const r of h.t.app.routeRegistry.filter((x) => x.method === 'GET')) {
      if (/events|openapi|healthz|readyz/.test(r.url)) continue
      for (const id of r.url.includes(':') ? ids : ['']) {
        const res = await h.call('GET', (id ? r.url.replace(/:\w+/g, id) : r.url) + query, { session })
        if (res.statusCode !== 200) continue
        ok++
        const hit = needles.find((n) => res.body.includes(n))
        if (hit) leaks.push(`${r.url} shows ${hit}`)
      }
    }
    expect(ok).toBeGreaterThan(50)
    expect(leaks).toEqual([])
  }, 120_000)
})
