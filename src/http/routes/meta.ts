import { getDefaultLocation } from '../../platform/locations.js'
import { DEFAULT_TZ, nowInfo } from '../../platform/time.js'
import { access } from '../access.js'
import { z } from '../zod.js'
import type { AppInstance } from '../types.js'

export const NowResponse = z.object({
  now: z.iso.datetime({ offset: true }),
  tz: z.string(),
  bizDate: z.string(),
  weekday: z.number().int().min(0).max(6),
  minutes: z.number().int().min(0).max(1439),
  dateLabel: z.string(),
})

/** Business timezone of the single location; falls back to the env default before a location row exists. */
export async function businessTz(app: AppInstance): Promise<string> {
  const loc = await getDefaultLocation(app.db).catch(() => undefined)
  return loc?.timezone ?? app.env.BUSINESS_TZ ?? DEFAULT_TZ
}

export function registerMetaRoutes(app: AppInstance): void {
  app.get(
    '/meta/now',
    {
      config: { access: access.public('Server clock for the dashboard tick; exposes no data') },
      schema: {
        tags: ['meta'],
        summary: 'Server time in the business timezone',
        response: { 200: NowResponse },
      },
    },
    async () => nowInfo(app.clock.now(), await businessTz(app)),
  )
}
