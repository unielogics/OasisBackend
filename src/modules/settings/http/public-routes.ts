// GET /public/hours: the opening hours for the public website (oasisautospanj.com), the one route of the API that answers without
// a session. nginx proxies exactly this path from the website's host, with cookies stripped and a 60-second cache in front
// (deploy/nginx/oasis-site.conf.template); the browser asks it again every few minutes. No personal or operations data leaves here.
import { access } from '../../../http/access.js'
import { z } from '../../../http/zod.js'
import { getDefaultLocation } from '../../../platform/locations.js'
import { DEFAULT_TZ, addDays, toBizDate } from '../../../platform/time.js'
import { listLiveClosures } from '../closures.js'
import { DEFAULT_HOURS } from '../defaults.js'
import { emergencySnapshot, getActiveEmergency } from '../emergency.js'
import { getHours } from '../hours.js'
import { PUBLIC_HOURS_DAYS, publicHoursView, type PublicHours } from '../public-hours.js'
import type { SettingsRuntime } from './runtime.js'

const Minutes = z.number().int().min(0).max(1440).nullable()

const PublicDayView = z.object({
  date: z.string(),
  weekday: z.number().int().min(0).max(6),
  day: z.string(),
  closed: z.boolean(),
  openMin: Minutes,
  closeMin: Minutes,
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  reason: z
    .string()
    .nullable()
    .describe(
      '"Regular day off", the closure name or the emergency closure name; null on an ordinary open day',
    ),
  reduced: z.boolean(),
  emergency: z.boolean(),
})

export const PublicHoursView = z.object({
  tz: z.string(),
  generatedAt: z.iso.datetime(),
  today: PublicDayView.extend({
    openNow: z.boolean(),
    state: z.enum(['open', 'opens_later', 'closed']),
  }),
  next: PublicDayView.nullable().describe(
    `The next day the shop opens after today, within ${PUBLIC_HOURS_DAYS} days`,
  ),
  week: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      day: z.string(),
      open: z.boolean(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      fromMin: Minutes,
      toMin: Minutes,
    }),
  ),
  closures: z.array(
    z.object({
      date: z.string(),
      dateLabel: z.string(),
      name: z.string(),
      type: z.enum(['closed', 'reduced']),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  ),
})

export const PUBLIC_HOURS_MAX_AGE = 60

export async function loadPublicHours(rt: SettingsRuntime): Promise<PublicHours> {
  const { app } = rt
  const now = app.clock.now()
  const loc = await getDefaultLocation(app.db).catch(() => undefined)
  const tz = loc?.timezone ?? app.env.BUSINESS_TZ ?? DEFAULT_TZ
  if (!loc) return publicHoursView({ now, tz, hours: DEFAULT_HOURS, closures: [], emergency: null })
  const today = toBizDate(now, tz)
  const [hours, closures, active] = await Promise.all([
    getHours(app.db, loc.id),
    listLiveClosures(app.db, loc.id, { from: today, to: addDays(today, PUBLIC_HOURS_DAYS - 1) }),
    getActiveEmergency(app.db, loc.id),
  ])
  return publicHoursView({ now, tz, hours, closures, emergency: emergencySnapshot(active, tz) })
}

export function registerPublicRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/public/hours',
    {
      config: {
        access: access.public('Opening hours for the public website; no personal or operations data'),
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['public'],
        operationId: 'getPublicHours',
        summary:
          'Opening hours for the public website: today, the next open day, the regular week and upcoming closures',
        description:
          'No session: the website calls it from the browser and at build time. Computed from the Settings (weekly hours, closures, an active emergency) ' +
          `at the moment of the call in the business timezone; \`Cache-Control: public, max-age=${PUBLIC_HOURS_MAX_AGE}\`, and nginx caches it on the website's host. ` +
          'Carries no personal or operations data (no names, counts, message text or ids). Rate limit 60 a minute per address.',
        response: { 200: PublicHoursView },
      },
    },
    async (_req, reply) => {
      void reply.header('Cache-Control', `public, max-age=${PUBLIC_HOURS_MAX_AGE}`)
      return loadPublicHours(rt)
    },
  )
}
