// Packages and add-ons for Settings: the list with ordered checklist tasks (ids), checklist saves, and catalog edits.
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import type { Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import {
  createService,
  listCatalog,
  putChecklist,
  requireService,
  updateService,
  type CatalogService,
  type ServicePatch,
} from '../service.js'
import {
  etag,
  expectedVersion,
  idem,
  inTx,
  requestContext,
  type SettingsRuntime,
} from '../../settings/http/runtime.js'

const TaskView = z.object({ id: z.string(), label: z.string(), position: z.number().int() })

export const ServiceView = z.object({
  id: z.string(),
  kind: z.enum(['package', 'addon']),
  name: z.string(),
  shortName: z.string(),
  shortNameOverride: z.string().nullable(),
  priceCents: z.number().int(),
  durationMin: z.number().int().describe('Packages 1 to 720 minutes; add-ons are always 0'),
  active: z.boolean(),
  bookableDesk: z.boolean(),
  sort: z.number().int(),
  tags: z.array(z.string()),
  sqspSku: z.string().nullable(),
  version: z.number().int(),
  taskCount: z.number().int(),
  tasks: z.array(TaskView),
})

export const CatalogView = z.object({ packages: z.array(ServiceView), addons: z.array(ServiceView) })

export const serviceView = (s: CatalogService): z.infer<typeof ServiceView> => ({
  id: s.id,
  kind: s.kind,
  name: s.name,
  shortName: s.shortName,
  shortNameOverride: s.shortNameOverride,
  priceCents: s.priceCents,
  durationMin: s.durationMin,
  active: s.active,
  bookableDesk: s.bookableDesk,
  sort: s.sort,
  tags: s.tags,
  sqspSku: s.sqspSku,
  version: s.version,
  taskCount: s.tasks.length,
  tasks: s.tasks.map((t) => ({ id: t.id, label: t.label, position: t.position })),
})

export async function loadCatalogView(
  db: Executor,
  locationId: string,
  includeInactive: boolean,
): Promise<z.infer<typeof CatalogView>> {
  const c = await listCatalog(db, locationId, { includeInactive })
  return { packages: c.packages.map(serviceView), addons: c.addons.map(serviceView) }
}

const Version = z.number().int().min(0).optional()
const Tags = z.array(z.string().max(32)).max(20)

export function registerCatalogRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/services',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['catalog'],
        operationId: 'listServices',
        summary: 'Packages and add-ons with their ordered checklist tasks (ids included)',
        description:
          'Active services only. `includeInactive=true` (retired ones too) needs set.services. Each service carries `version`, the token for checklist and catalog edits.',
        querystring: z.object({ includeInactive: z.enum(['true', 'false']).default('false') }),
        response: { 200: CatalogView },
      },
    },
    async (req) => {
      const includeInactive = req.query.includeInactive === 'true'
      if (includeInactive && !hasPermission(req.auth!, 'set.services'))
        throw new AppError('FORBIDDEN', { meta: { required: ['set.services'], mode: 'all' } })
      return loadCatalogView(app.db, requestContext(req).locationId, includeInactive)
    },
  )

  app.put(
    '/services/:id/checklist',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: ['catalog'],
        operationId: 'putServiceChecklist',
        summary: 'Save the whole ordered checklist of a package or add-on',
        description:
          'Body `tasks` is the full ordered list of `{id?, label}` (a bare string is a label without an id). Labels are trimmed and empty ones dropped. Ids are stable: an entry with an id keeps that task (rename and reorder never change ids), an id-less entry that equals an unclaimed label keeps that task, then the unclaimed task at the same position is renamed, otherwise a task is created; tasks nobody claimed are retired, never deleted. ' +
          '`version` (or If-Match) is optional and enforced when sent: 412 VERSION_CONFLICT otherwise. Triggers the ChecklistSync port for jobs not yet started. Publishes `settings.changed {section: "services"}`.',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            tasks: z
              .array(
                z.union([
                  z.string().max(300),
                  z.object({ id: z.string().uuid().optional(), label: z.string().max(300) }).strict(),
                ]),
              )
              .max(200),
            version: Version,
          })
          .strict(),
        response: {
          200: z.object({
            service: ServiceView,
            changed: z.boolean(),
            summary: z.object({
              renamed: z.number().int(),
              created: z.number().int(),
              retired: z.number().int(),
              revived: z.number().int(),
              moved: z.number().int(),
            }),
          }),
        },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const out = await inTx(app.db, async (tx) => {
        const r = await putChecklist(tx, {
          locationId: c.locationId,
          serviceId: req.params.id,
          tasks: req.body.tasks,
          expectedVersion: expectedVersion(req, req.body.version),
          newId: app.newId,
          audit: c.audit,
        })
        if (r.changed)
          await rt.ports().checklistSync(tx, {
            locationId: c.locationId,
            serviceId: r.service.id,
            created: r.plan.createdIds,
            renamed: r.plan.renamed.map((x) => x.id),
            retired: r.plan.retired.map((x) => x.id),
          })
        return r
      })
      etag(reply, out.service.version)
      return {
        service: serviceView(out.service),
        changed: out.changed,
        summary: {
          renamed: out.plan.renamed.length,
          created: out.plan.created.length,
          retired: out.plan.retired.length,
          revived: out.plan.revived.length,
          moved: out.plan.moved.length,
        },
      }
    },
  )

  app.post(
    '/services',
    {
      config: { access: access.perm('set.services'), idempotency: 'optional' },
      schema: {
        tags: ['catalog'],
        operationId: 'createService',
        summary: 'Add a package or add-on',
        description:
          'Price in cents. Packages need `durationMin` (1 to 720); add-ons have no duration. Names are unique per kind, case-insensitively (422 otherwise). No Settings UI uses this yet.',
        body: z
          .object({
            kind: z.enum(['package', 'addon']),
            name: z.string().max(200),
            priceCents: z.number().int(),
            durationMin: z.number().int().optional(),
            shortName: z.string().max(100).nullable().optional(),
            tags: Tags.optional(),
            bookableDesk: z.boolean().optional(),
            sort: z.number().int().optional(),
            active: z.boolean().optional(),
            sqspSku: z.string().max(100).nullable().optional(),
            tasks: z.array(z.string().max(300)).max(200).optional(),
          })
          .strict(),
        response: { 201: ServiceView },
      },
    },
    idem(async (req, tx) => {
      const c = requestContext(req)
      const b = req.body as {
        kind: 'package' | 'addon'
        name: string
        priceCents: number
        durationMin?: number
        shortName?: string | null
        tags?: string[]
        bookableDesk?: boolean
        sort?: number
        active?: boolean
        sqspSku?: string | null
        tasks?: string[]
      }
      if (b.kind === 'addon' && b.durationMin !== undefined && b.durationMin !== 0)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Add-ons do not have a duration.',
          errors: [{ path: 'durationMin', message: 'Add-ons do not have a duration.' }],
        })
      const s = await createService(tx, { ...b, locationId: c.locationId, newId: app.newId, audit: c.audit })
      return { status: 201, body: serviceView(s) }
    }),
  )

  app.patch(
    '/services/:id',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: ['catalog'],
        operationId: 'updateService',
        summary: 'Edit a package or add-on: name, price, duration, bookable at the desk, active',
        description:
          '`version` (or If-Match) is optional and enforced when sent. Retired services (`active: false`) stay in the table because appointments snapshot them. Appointments keep their own name, price and duration. Publishes `settings.changed {section: "services"}`.',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            name: z.string().max(200).optional(),
            shortName: z.string().max(100).nullable().optional(),
            priceCents: z.number().int().optional(),
            durationMin: z.number().int().optional(),
            tags: Tags.optional(),
            bookableDesk: z.boolean().optional(),
            sort: z.number().int().optional(),
            active: z.boolean().optional(),
            sqspSku: z.string().max(100).nullable().optional(),
            version: Version,
          })
          .strict(),
        response: { 200: ServiceView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version, ...patch } = req.body
      const s = await inTx(app.db, async (tx) => {
        await updateService(tx, {
          locationId: c.locationId,
          serviceId: req.params.id,
          patch: patch as ServicePatch,
          expectedVersion: expectedVersion(req, version),
          audit: c.audit,
        })
        return requireService(tx, c.locationId, req.params.id)
      })
      etag(reply, s.version)
      return serviceView(s)
    },
  )
}
