// GET /api/v1/leads (ADR 0160, plan J and K; wave W3b): the staff list of leads, newest contact first, with the interest categories
// in their Settings labels and colours. The number shows only with cli.contact (like the client file); without it the lead still
// names the client. Read-only: the assistant opens leads, a booking closes them, the follow-up job texts them once.
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { listCategories } from '../../catalog/categories.js'
import { listLeads } from '../service.js'

const TAGS = ['customers']
const iso = z.string().nullable()

export const LeadDto = z.object({
  id: z.string(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable().describe('The client’s name; "New texter ••NNNN" while the welcome flow has no name yet'),
  needsName: z.boolean().describe('The client record is still the welcome flow’s placeholder'),
  phone: z.string().nullable().describe('The number (E.164); null without cli.contact'),
  source: z.enum(['text', 'website', 'walk_in']),
  interests: z
    .array(z.object({ key: z.string(), label: z.string(), colour: z.string().nullable() }))
    .describe('The categories they asked about, in the Settings labels and colours (a deleted category keeps its key as label)'),
  status: z.enum(['new', 'followed_up', 'booked', 'closed']),
  firstContactAt: z.string(),
  lastContactAt: z.string(),
  followUpAt: iso.describe('When the one automatic follow-up is planned (null: none planned)'),
  followedUpAt: iso.describe('When the follow-up text was queued'),
  bookedAppointmentId: z.string().nullable(),
  closedAt: iso,
})

const ListQuery = z.object({
  status: z.enum(['open', 'all', 'new', 'followed_up', 'booked', 'closed']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const d = (x: Date | null): string | null => (x ? x.toISOString() : null)

export function registerLeadRoutes(app: AppInstance): void {
  app.get(
    '/leads',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: TAGS,
        summary: 'Leads: numbers that asked about a service and did not book yet',
        description:
          'One lead per number (source text, website or walk-in) with the categories they asked about, the one automatic follow-up (planned / sent) and the booking that closed it. `status=open` (the default) lists new and followed-up leads; `all` or one status lists those. The number appears only with cli.contact.',
        querystring: ListQuery,
        response: { 200: z.object({ leads: z.array(LeadDto) }) },
      },
    },
    async (req) => {
      const locationId = req.auth!.locationId
      const contact = hasPermission(req.auth!, 'cli.contact')
      const [rows, categories] = await Promise.all([
        listLeads(app.db, { locationId, status: req.query.status, limit: req.query.limit }),
        listCategories(app.db, locationId),
      ])
      const byKey = new Map(categories.map((c) => [c.key, c]))
      return {
        leads: rows.map((r) => ({
          id: r.id,
          customerId: r.customerId,
          customerName: r.customerName,
          needsName: r.customerNeedsDetails,
          phone: contact ? r.phone : null,
          source: r.source,
          interests: r.interests.map((k) => ({ key: k, label: byKey.get(k)?.label ?? k, colour: byKey.get(k)?.colour ?? null })),
          status: r.status,
          firstContactAt: r.firstContactAt.toISOString(),
          lastContactAt: r.lastContactAt.toISOString(),
          followUpAt: d(r.followUpAt),
          followedUpAt: d(r.followedUpAt),
          bookedAppointmentId: r.bookedAppointmentId,
          closedAt: d(r.closedAt),
        })),
      }
    },
  )
}
