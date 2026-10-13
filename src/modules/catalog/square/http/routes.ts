// The Square item library routes (ADR 0172, api-spec section 30.14; all set.billing, all audited):
//   GET  /integrations/square/items              the Square item library block: mode, tax check, counts, last sync, failures, preview
//   POST /integrations/square/items/sync         "Sync now" ({drift?}); while the sync is not on, a read-only preview
//   PUT  /integrations/square/items/tax          which Square tax Oasis items carry: auto | adopt (squareTaxId) | create (version)
//   POST /integrations/square/items/archive-all  the rollback: every Oasis item archived at Square (writes on, item sync off)
import type { FastifyRequest } from 'fastify'
import { access } from '../../../../http/access.js'
import { auditContextOf } from '../../../../http/authorizer.js'
import type { AppInstance } from '../../../../http/types.js'
import { z } from '../../../../http/zod.js'
import * as audit from '../../../../platform/audit.js'
import { AppError } from '../../../../platform/errors.js'
import { squareEnvironment } from '../../../square/db/state.js'
import { squareApi, squareEnv } from '../../../square/runtime.js'
import { etag, requiredVersion } from '../../../settings/http/runtime.js'
import { archiveAllItems, itemsMode, runItemSync, saveItemsState, type ItemSyncDeps } from '../sync.js'
import { loadItemsView } from '../view.js'
import '../problems.js'

const TAG = 'square'
const iso = z.iso.datetime({ offset: true })

const TaxCheckView = z
  .object({
    status: z.enum(['ok', 'create', 'blocked', 'error']).describe('ok: Oasis items use taxId; create: the sync will add Oasis’s own; blocked or error: the sync is paused'),
    mode: z.enum(['auto', 'adopt', 'create']),
    taxId: z.string().nullable(),
    taxName: z.string().nullable(),
    percentage: z.string().nullable().describe('Square’s percentage of that tax, as Square writes it ("6.625")'),
    wantPercentage: z.string().describe('Oasis’s rate (tax.rate_dbp) as a Square percentage'),
    own: z.boolean().describe('Oasis made this tax: the sync keeps it at Oasis’s rate'),
    ownChanged: z
      .array(z.string())
      .describe('Oasis’s own tax only: what was changed in Square besides its percentage ("turned off", "included in the price, not added to it", …); the next sync puts it back'),
    detail: z.string().describe('In plain words'),
    warnings: z.array(z.string()),
    candidates: z
      .array(z.object({ id: z.string(), name: z.string(), percentage: z.string().nullable(), matches: z.boolean(), problem: z.string().nullable() }))
      .describe('The enabled Square taxes at the shop (Oasis’s own excluded): what PUT …/items/tax can adopt'),
    rounding: z.object({ checked: z.number().int(), differ: z.number().int(), detail: z.string() }).optional(),
  })
  .describe('The last tax check (Test connection, the preview and every sync run it)')

const Preview = z.object({
  create: z.number().int().describe('Items the sync would make'),
  createPrices: z.number().int().describe('Prices (variations) on them'),
  update: z.number().int(),
  archive: z.number().int(),
  unchanged: z.number().int(),
  skipped: z.number().int().describe('Services not sold (off, quote-only, no price) and never made'),
  categories: z.number().int().describe('Categories the sync would make (or adopt by name)'),
  tax: z.enum(['create', 'update', 'adopt', 'none', 'blocked']),
  at: iso,
})

export const ItemsViewSchema = z.object({
  mode: z.enum(['on', 'preview', 'off']).describe('on: the sync writes; preview: watch-only (SQUARE_WRITES_ENABLED=false); off: SQUARE_ITEMS_SYNC_ENABLED=false'),
  environment: z.enum(['sim', 'sandbox', 'production']),
  writesEnabled: z.boolean(),
  itemsSyncEnabled: z.boolean(),
  taxMode: z.enum(['auto', 'adopt', 'create']),
  taxObjectId: z.string().nullable().describe('mode adopt: the Square tax picked'),
  taxCheck: TaxCheckView.nullable(),
  taxCheckedAt: iso.nullable(),
  counts: z.object({
    onSquare: z.number().int(),
    waiting: z.number().int(),
    failed: z.number().int(),
    archived: z.number().int(),
    notSold: z.number().int(),
  }),
  lastSyncAt: iso.nullable(),
  lastSync: z.record(z.string(), z.unknown()).nullable(),
  lastDriftAt: iso.nullable(),
  lastWriteAt: iso.nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: iso.nullable(),
  failures: z.array(z.object({ serviceId: z.string(), service: z.string(), error: z.string().nullable() })),
  preview: Preview.nullable().describe('The last read-only preview (POST …/items/sync while the sync is not on)'),
  version: z.number().int().describe('The token PUT /integrations/square/items/tax takes'),
})

const SyncReport = z.object({
  status: z.enum(['skipped', 'preview', 'blocked', 'done']),
  reason: z.string().optional(),
  mode: z.enum(['on', 'preview', 'off']),
  tax: TaxCheckView.nullable(),
  created: z.number().int(),
  updated: z.number().int(),
  archived: z.number().int(),
  recreated: z.number().int(),
  adopted: z.number().int(),
  restored: z.number().int().describe('Square-side edits of Oasis’s fields put back'),
  failed: z.number().int(),
  categoriesCreated: z.number().int(),
  taxCreated: z.number().int(),
  taxUpdated: z.number().int(),
  preview: Preview.optional(),
  failures: z.array(z.string()),
  changedInSquare: z.array(z.string()),
  reported: z.array(z.string()),
})

export function registerSquareItemsRoutes(app: AppInstance): void {
  const loc = (req: FastifyRequest): string => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth.locationId
  }
  const deps = (): ItemSyncDeps => {
    const env = squareEnv()
    return { db: app.db, clock: app.clock, newId: app.newId, env, api: squareApi(env) }
  }

  app.get(
    '/integrations/square/items',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        operationId: 'getSquareItems',
        summary: 'The Square item library: mode, tax check, counts, last sync, failures, preview',
        description:
          'Read from Oasis only (no Square call): whether the sync writes (`mode`), the last tax check, how many services are on Square, waiting, failed, archived or not sold, the last sync and drift check, the failures as service and error, and the last read-only preview. `version` is the token of PUT /integrations/square/items/tax.',
        response: { 200: ItemsViewSchema },
      },
    },
    async (req) => loadItemsView(app.db, loc(req), squareEnv()),
  )

  app.post(
    '/integrations/square/items/sync',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        operationId: 'syncSquareItems',
        summary: 'Sync the services to Square’s item library now (a read-only preview while the sync is not on)',
        description:
          'Runs what the job `square.items.sync` runs every 5 minutes (`drift: true`: what the nightly `square.items.drift` runs: everything read back). With SQUARE_WRITES_ENABLED and SQUARE_ITEMS_SYNC_ENABLED on, items are made, updated, archived or hidden (never deleted); otherwise nothing is written at Square and the answer is `status: preview` with what the sync would do (`preview`) and the tax check. A tax that does not match blocks the sync (`status: blocked`, `reason`). One writing run at a time: while the job (or another Sync now) is running the answer is `status: skipped` with `reason` "A Square item sync is already running: try again in a minute". Audited `square.items.sync`.',
        body: z.object({ drift: z.boolean().optional() }).strict(),
        response: { 200: SyncReport },
      },
    },
    async (req) => {
      const d = deps()
      const b = req.body as { drift?: boolean }
      return runItemSync(d, loc(req), { drift: b.drift === true, dryRun: itemsMode(d.env) !== 'on', actor: auditContextOf(req) })
    },
  )

  app.put(
    '/integrations/square/items/tax',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        operationId: 'putSquareItemsTax',
        summary: 'Choose which Square tax Oasis items carry (ETag = version)',
        description:
          '`auto` (the default): the one Square tax at the shop that matches Oasis’s rate, else Oasis’s own when the shop has none; `adopt`: the tax `squareTaxId` (one of the tax check’s candidates; it must match Oasis’s rate or the sync stays paused); `create`: Oasis’s own "Sales tax" whatever the shop has. Takes effect at the next sync. `version` (or If-Match) required: 428 without, 412 when stale. Audited `square.items.tax`.',
        body: z
          .object({ mode: z.enum(['auto', 'adopt', 'create']), squareTaxId: z.string().min(1).max(64).optional(), version: z.number().int().min(0).optional() })
          .strict(),
        response: { 200: z.object({ mode: z.enum(['auto', 'adopt', 'create']), squareTaxId: z.string().nullable(), version: z.number().int() }) },
      },
    },
    async (req, reply) => {
      const b = req.body as { mode: 'auto' | 'adopt' | 'create'; squareTaxId?: string; version?: number }
      const v = requiredVersion(req, b.version)
      if (b.mode === 'adopt' && !b.squareTaxId)
        throw new AppError('VALIDATION_FAILED', { detail: 'Pick the Square tax', errors: [{ path: 'squareTaxId', message: 'Pick one of the Square taxes at the shop.' }] })
      const locationId = loc(req)
      const environment = squareEnvironment(squareEnv())
      const out = await app.db.transaction().execute(async (tx) => {
        const cur = await tx
          .selectFrom('square_items_state')
          .select(['tax_mode', 'tax_object_id', 'version'])
          .where('location_id', '=', locationId)
          .where('environment', '=', environment)
          .forUpdate()
          .executeTakeFirst()
        if (v !== (cur?.version ?? 0)) throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: cur?.version ?? 0 } })
        const next = { tax_mode: b.mode, tax_object_id: b.mode === 'adopt' ? b.squareTaxId! : null, fingerprint: null }
        await saveItemsState(tx, locationId, environment, app.clock.now(), next, { bumpVersion: true })
        const after = await tx.selectFrom('square_items_state').select(['tax_mode', 'tax_object_id', 'version']).where('location_id', '=', locationId).where('environment', '=', environment).executeTakeFirstOrThrow()
        await audit.record(tx, {
          locationId,
          action: 'square.items.tax',
          entityType: 'integration',
          entityId: 'square',
          before: { mode: cur?.tax_mode ?? 'auto', squareTaxId: cur?.tax_object_id ?? null },
          after: { mode: after.tax_mode, squareTaxId: after.tax_object_id, environment },
          ctx: auditContextOf(req),
        })
        return { mode: after.tax_mode, squareTaxId: after.tax_object_id, version: after.version }
      })
      etag(reply, out.version)
      return out
    },
  )

  app.post(
    '/integrations/square/items/archive-all',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        operationId: 'archiveAllSquareItems',
        summary: 'Rollback: archive every Oasis item at Square (asks first in the dashboard)',
        description:
          'Every item Oasis made is archived at Square (hidden from the POS, kept for reports; nothing is deleted). Needs Square writes on (409 `SQUARE_WRITES_OFF`) and the item sync turned off first (409 `SQUARE_ITEMS_SYNC_ON`: it would put them back on sale). Turning the sync on again later re-sends every item. Audited `square.items.archive_all`.',
        body: z.object({}).strict(),
        response: { 200: z.object({ archived: z.number().int(), alreadyArchived: z.number().int(), failed: z.number().int(), failures: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const d = deps()
      if (!d.env.SQUARE_WRITES_ENABLED) throw new AppError('SQUARE_WRITES_OFF')
      if (d.env.SQUARE_ITEMS_SYNC_ENABLED) throw new AppError('SQUARE_ITEMS_SYNC_ON')
      return archiveAllItems(d, loc(req), auditContextOf(req))
    },
  )
}
