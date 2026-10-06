// GET /settings/bundle: everything the Settings screen needs in one call, filtered by what the caller may read.
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import type { Executor } from '../../../platform/db.js'
import { toBizDate } from '../../../platform/time.js'
import { CatalogView, loadCatalogView } from '../../catalog/http/routes.js'
import { clientView } from '../../customers/http/vip-clients.js'
import { listVipClients } from '../vip.js'
import { listClosureViews } from '../closures.js'
import { ClosureList, closureListView } from './closure-routes.js'
import { EmergencyView, loadEmergencyView } from './emergency-routes.js'
import { HoursDayView, RulesView, loadHoursView } from './hours-routes.js'
import { ArrivalView, VipView, loadArrivalView, loadVipView } from './vip-routes.js'
import { businessTzOf, requestContext, type SettingsRuntime } from './runtime.js'

/**
 * Parts of the bundle that need a permission beyond being signed in, mirroring the permission of the route that serves
 * the same data on its own. Everything else is readable by any signed-in user (the GET routes are `authenticated`).
 */
export const BUNDLE_READ_PERMISSIONS = {
  'emergency.history': 'set.emergency',
  'vip.clients': 'cli.member',
  'counts.employees': 'team.view',
} as const

export type BundlePart = keyof typeof BUNDLE_READ_PERMISSIONS

const ClientRow = z.object({ customerId: z.string(), fullName: z.string(), addedAt: z.string() })

export const SettingsBundle = z.object({
  generatedAt: z.string(),
  hours: z.object({
    days: z.array(HoursDayView),
    weekHours: z.string(),
    weekMinutes: z.number().int(),
    version: z.number().int(),
  }),
  rules: RulesView,
  federalAuto: z.boolean(),
  closures: z.object({ upcoming: ClosureList.shape.upcoming, past: ClosureList.shape.past }),
  emergency: EmergencyView,
  vip: VipView.extend({ clients: z.array(ClientRow).optional() }),
  arrival: ArrivalView,
  services: CatalogView,
  counts: z.object({ employees: z.number().int().optional() }),
  omitted: z
    .array(z.string())
    .describe('Parts left out because the caller lacks the permission to read them'),
})

async function countEmployees(db: Executor): Promise<number> {
  const r = await db
    .selectFrom('employees')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow()
  return Number(r.n)
}

export function registerBundleRoute(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/settings/bundle',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getSettingsBundle',
        summary: "The Settings screen in one call, filtered by the caller's permissions",
        description:
          'Hours, booking rules, the federal toggle, closures (upcoming and past with real counts), the emergency state with the idle strip, VIP settings and holds, arrival settings, services with tasks, and the employee count. ' +
          'Parts that need more than a session are left out and named in `omitted`: `emergency.history` (set.emergency), `vip.clients` (cli.member), `counts.employees` (team.view). Active services only.',
        response: { 200: SettingsBundle },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const auth = req.auth!
      const can = (part: BundlePart): boolean => hasPermission(auth, BUNDLE_READ_PERMISSIONS[part])
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const now = app.clock.now()
      const [hours, closures, emergency, vip, arrival, services, clients, employees] = await Promise.all([
        loadHoursView(app.db, c.locationId),
        listClosureViews(app.db, {
          locationId: c.locationId,
          today: toBizDate(now, tz),
          tz,
          counter: rt.ports().counter,
        }),
        loadEmergencyView(app.db, {
          locationId: c.locationId,
          now,
          tz,
          canClose: hasPermission(auth, 'set.emergency'),
        }),
        loadVipView(app.db, c.locationId),
        loadArrivalView(app.db, c.locationId),
        loadCatalogView(app.db, c.locationId, false),
        can('vip.clients') ? listVipClients(app.db, c.locationId) : Promise.resolve(null),
        can('counts.employees') ? countEmployees(app.db) : Promise.resolve(null),
      ])
      const omitted = (Object.keys(BUNDLE_READ_PERMISSIONS) as BundlePart[]).filter((p) => !can(p))
      const closureView = closureListView(closures)
      return {
        generatedAt: now.toISOString(),
        hours: {
          days: hours.days,
          weekHours: hours.weekHours,
          weekMinutes: hours.weekMinutes,
          version: hours.version,
        },
        rules: hours.rules,
        federalAuto: hours.federalAuto,
        closures: { upcoming: closureView.upcoming, past: closureView.past },
        emergency,
        vip: clients ? { ...vip, clients: clients.map(clientView) } : vip,
        arrival,
        services,
        counts: employees === null ? {} : { employees },
        omitted,
      }
    },
  )
}
