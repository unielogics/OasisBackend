// Syncing the tier prices to Square's catalog (ADR 0171 wave Q3b, design 5.2): every current tier price becomes a Square plan
// variation members can be billed at. Three triggers, one function (runCatalogSync):
//   - the job square.catalog.sync, every 5 minutes: what a tier-price save left pending (square_state 'pending');
//   - the nightly job square.catalog.drift: the same, plus Square's catalog read back and compared (drift is reported, never
//     overwritten: a price changed in the Square Dashboard is the owner's to look at);
//   - POST /integrations/square/catalog/sync (set.billing): "Sync to Square" now.
// The Square calls run one at a time OUTSIDE any transaction, each with a key derived from our own row ids and the object's content
// (ct_<...>): a run that stopped after Square answered and before our row was written sends the same request again and gets the same
// object. Each answer is then written in its own short transaction. Nothing runs while SQUARE_WRITES_ENABLED is false.
import type { Env } from '../../../config/env.js'
import type { SquareApi } from '../../../integrations/ports/square.js'
import { SquareApiError, SquareWritesDisabled } from '../../../integrations/square/errors.js'
import { sqKey } from '../../../integrations/square/keys.js'
import { usd } from '../../../integrations/square/money.js'
import type { WireCatalogObject } from '../../../integrations/square/wire.js'
import * as audit from '../../../platform/audit.js'
import type { Clock } from '../../../platform/clock.js'
import { transaction, type Db, type Executor } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { maskText } from '../../../platform/logging.js'
import { notifyManagers } from '../../messaging/notify.js'
import type { SquareLogger } from '../../square/ingest.js'
import { squareWritesOn } from '../../square/links.js'
import { planCatalogChanges, remoteOf, type CatalogAction, type CatalogPriceRow, type CatalogTier, type RemoteCatalog } from './catalog-plan.js'
import '../schema.js'
import './schema.js'

export interface CatalogSyncDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Pick<Env, 'SQUARE_WRITES_ENABLED'>
  api: SquareApi
  logger?: SquareLogger
}

export interface CatalogSyncReport {
  status: 'skipped' | 'done'
  reason?: string
  plansCreated: number
  plansRenamed: number
  variationsCreated: number
  retired: number
  kept: number
  drift: number
  recreated: number
  failed: number
}

const empty = (status: CatalogSyncReport['status'], reason?: string): CatalogSyncReport => ({
  status,
  ...(reason ? { reason } : {}),
  plansCreated: 0,
  plansRenamed: 0,
  variationsCreated: 0,
  retired: 0,
  kept: 0,
  drift: 0,
  recreated: 0,
  failed: 0,
})

/** The tiers and every price row of a location, as the planner reads them. */
export async function loadCatalogState(db: Executor, locationId: string): Promise<{ tiers: CatalogTier[]; rows: CatalogPriceRow[] }> {
  const tiers = await db
    .selectFrom('membership_plans')
    .select(['id', 'key', 'name', 'active', 'square_plan_id'])
    .where('location_id', '=', locationId)
    .orderBy('sort')
    .orderBy('key')
    .execute()
  const rows = await db
    .selectFrom('membership_tier_prices as p')
    .leftJoin('vehicle_classes as c', (j) => j.onRef('c.location_id', '=', 'p.location_id').onRef('c.key', '=', 'p.class_key'))
    .select(['p.id', 'p.plan_id', 'p.class_key', 'c.label', 'p.monthly_cents', 'p.superseded_at', 'p.square_variation_id', 'p.square_state', 'p.square_error'])
    .select((eb) => [
      eb
        .or([
          eb.exists(eb.selectFrom('memberships as m').select('m.id').whereRef('m.tier_price_id', '=', 'p.id')),
          eb.exists(eb.selectFrom('square_enrollments as e').select('e.id').whereRef('e.tier_price_id', '=', 'p.id')),
        ])
        .as('in_use'),
    ])
    .where('p.location_id', '=', locationId)
    .orderBy('p.effective_from')
    .orderBy('p.id')
    .execute()
  return {
    tiers: tiers.map((t) => ({ planId: t.id, key: t.key, name: t.name, active: t.active, squarePlanId: t.square_plan_id })),
    rows: rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      classKey: r.class_key,
      classLabel: r.label ?? r.class_key,
      monthlyCents: r.monthly_cents,
      current: r.superseded_at === null,
      squareVariationId: r.square_variation_id,
      squareState: r.square_state,
      inUse: r.in_use === true,
      squareError: r.square_error,
    })),
  }
}

/** Square's subscription plans and variations (paged; read-only, allowed in watch-only mode too). */
export async function readRemoteCatalog(api: SquareApi): Promise<RemoteCatalog> {
  const all: WireCatalogObject[] = []
  let cursor: string | undefined
  for (let i = 0; i < 50; i++) {
    const page = await api.catalog.search({ object_types: ['SUBSCRIPTION_PLAN', 'SUBSCRIPTION_PLAN_VARIATION'], cursor, include_deleted_objects: false })
    all.push(...page.items)
    cursor = page.cursor
    if (!cursor) break
  }
  return remoteOf(all as Parameters<typeof remoteOf>[0])
}

/** The request body of a variation: one phase, MONTHLY, a STATIC price (plan decision 2: the price is the tier price at that size). */
export function variationObject(tempId: string, name: string, squarePlanId: string, cents: number) {
  return {
    type: 'SUBSCRIPTION_PLAN_VARIATION',
    id: tempId,
    subscription_plan_variation_data: {
      name,
      subscription_plan_id: squarePlanId,
      phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: usd(cents) } }],
    },
  }
}

/** A failure in words for the row (Square's own detail, masked; never a token). */
const why = (e: unknown): string => {
  if (e instanceof SquareWritesDisabled) return 'Square is in watch-only mode'
  if (e instanceof SquareApiError && e.retryable) return 'Square did not answer'
  if (e instanceof SquareApiError) return maskText(`Square refused it: ${e.errors.map((x) => x.detail ?? x.code ?? '').filter(Boolean).join('; ') || e.status}`).slice(0, 300)
  return 'Square did not answer'
}

/** Square refuses to delete a variation a subscription used (even a canceled one): 400 BAD_REQUEST (sandbox 2026-10-12). */
const keptBySquare = (e: unknown): boolean => e instanceof SquareApiError && e.status === 400

export interface ExecutedAction {
  action: CatalogAction
  ok: boolean
  squareId?: string
  error?: string
  /** retire_variation only: Square keeps it (a subscription used it). */
  kept?: boolean
}

/**
 * Sends the planned actions to Square in order (plans first, so a variation can name the plan this run made). No database access:
 * the sandbox verification (pnpm verify:square, SQR-13) runs exactly this against Square.
 */
export async function executeCatalogActions(api: SquareApi, actions: readonly CatalogAction[]): Promise<ExecutedAction[]> {
  const out: ExecutedAction[] = []
  const madePlans = new Map<string, string>()
  const ordered = [...actions].sort((a, b) => rank(a) - rank(b))
  for (const a of ordered) {
    try {
      switch (a.kind) {
        case 'create_plan': {
          const r = await api.catalog.upsert(sqKey('ct', `plan:${a.planId}:${a.name}`), {
            type: 'SUBSCRIPTION_PLAN',
            id: '#oasis-plan',
            subscription_plan_data: { name: a.name },
          })
          madePlans.set(a.planId, r.object.id)
          out.push({ action: a, ok: true, squareId: r.object.id })
          break
        }
        case 'rename_plan': {
          const cur = await api.catalog.retrieve(a.squarePlanId)
          const r = await api.catalog.upsert(sqKey('ct', `rename:${a.squarePlanId}:${cur.version ?? a.version}:${a.name}`), {
            ...cur,
            subscription_plan_data: { ...(cur.subscription_plan_data ?? {}), name: a.name },
          })
          out.push({ action: a, ok: true, squareId: r.object.id })
          break
        }
        case 'create_variation': {
          const planId = a.squarePlanId ?? madePlans.get(a.planId)
          if (!planId) {
            out.push({ action: a, ok: false, error: 'The tier’s Square plan could not be made' })
            break
          }
          const r = await api.catalog.upsert(
            sqKey('ct', `var:${a.rowId}:${planId}:${a.name}:${a.cents}`),
            variationObject('#oasis-variation', a.name, planId, a.cents),
          )
          out.push({ action: a, ok: true, squareId: r.object.id })
          break
        }
        case 'retire_variation':
          try {
            await api.catalog.delete(a.squareVariationId)
            out.push({ action: a, ok: true })
          } catch (e) {
            if (!keptBySquare(e)) throw e
            out.push({ action: a, ok: true, kept: true, error: 'Square keeps it: a subscription used it' })
          }
          break
        case 'drift':
        case 'recreate':
          out.push({ action: a, ok: true })
          break
      }
    } catch (e) {
      out.push({ action: a, ok: false, error: why(e) })
    }
  }
  return out
}

const rank = (a: CatalogAction): number =>
  a.kind === 'create_plan' ? 0 : a.kind === 'rename_plan' ? 1 : a.kind === 'create_variation' ? 2 : 3

/** Writes what Square answered, one short transaction per action. */
async function record(deps: CatalogSyncDeps, locationId: string, done: readonly ExecutedAction[], report: CatalogSyncReport): Promise<string[]> {
  const now = deps.clock.now()
  const failures: string[] = []
  for (const x of done) {
    const a = x.action
    await transaction(deps.db, async (tx) => {
      switch (a.kind) {
        case 'create_plan':
          if (x.ok) {
            await tx.updateTable('membership_plans').set({ square_plan_id: x.squareId! }).where('id', '=', a.planId).where('square_plan_id', 'is', null).execute()
            report.plansCreated++
          } else failures.push(`${a.name}: ${x.error}`)
          break
        case 'rename_plan':
          if (x.ok) report.plansRenamed++
          else failures.push(`${a.name}: ${x.error}`)
          break
        case 'create_variation':
          if (x.ok) {
            await tx
              .updateTable('membership_tier_prices')
              .set({ square_variation_id: x.squareId!, square_state: 'synced', square_synced_at: now, square_error: null })
              .where('id', '=', a.rowId)
              .execute()
            report.variationsCreated++
          } else {
            await tx.updateTable('membership_tier_prices').set({ square_state: 'failed', square_error: x.error ?? null }).where('id', '=', a.rowId).execute()
            report.failed++
            failures.push(`${a.name}: ${x.error}`)
          }
          break
        case 'retire_variation':
          if (x.ok && !x.kept) {
            await tx.updateTable('membership_tier_prices').set({ square_state: 'retired', square_synced_at: now, square_error: null }).where('id', '=', a.rowId).execute()
            report.retired++
          } else if (x.kept) {
            await tx.updateTable('membership_tier_prices').set({ square_error: x.error ?? 'Square keeps it' }).where('id', '=', a.rowId).execute()
            report.kept++
          } else report.failed++
          break
        case 'drift':
          await tx.updateTable('membership_tier_prices').set({ square_state: 'failed', square_error: a.detail.slice(0, 300) }).where('id', '=', a.rowId).execute()
          report.drift++
          failures.push(a.detail)
          break
        case 'recreate':
          await tx
            .updateTable('membership_tier_prices')
            .set({ square_state: 'pending', square_variation_id: null, square_synced_at: null, square_error: a.detail.slice(0, 300) })
            .where('id', '=', a.rowId)
            .execute()
          report.recreated++
          break
      }
    })
  }
  if (done.length > 0)
    await transaction(deps.db, async (tx) => {
      await audit.record(tx, {
        locationId,
        action: 'square.catalog.sync',
        entityType: 'integration',
        entityId: 'square',
        after: { ...report },
        ctx: { actor: { name: 'Square sync' } },
      })
    })
  return failures
}

/**
 * Syncs one location's tier prices to Square (see the header). `drift` also reads Square's catalog back. Skipped (nothing read or
 * sent) while Square writes are off. A failure is kept on the row (square_state failed, square_error) and the managers are told
 * once per run; the next run tries a failed row again.
 */
export async function runCatalogSync(deps: CatalogSyncDeps, locationId: string, o: { drift?: boolean } = {}): Promise<CatalogSyncReport> {
  if (!squareWritesOn(deps.env)) return empty('skipped', 'Square writes are off (SQUARE_WRITES_ENABLED=false)')
  const state = await loadCatalogState(deps.db, locationId)
  const remote = o.drift ? await readRemoteCatalog(deps.api) : undefined
  const actions = planCatalogChanges(state.tiers, state.rows, remote)
  const report = empty('done')
  if (actions.length === 0) return report
  const done = await executeCatalogActions(deps.api, actions)
  const failures = await record(deps, locationId, done, report)
  if (failures.length > 0) {
    deps.logger?.warn({ square: { catalog: report } }, 'square catalog sync: some prices are not synced')
    await transaction(deps.db, (tx) =>
      notifyManagers(
        tx,
        {
          locationId,
          kind: 'square.catalog_sync_failed',
          title: 'Membership prices not synced to Square',
          body: `Some membership prices could not be set up at Square, so those sizes can’t be joined online yet: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? ` (and ${failures.length - 5} more)` : ''}. Settings → Memberships → Sync to Square tries again.`,
          entityType: 'integration',
          entityId: 'square',
        },
        { newId: deps.newId, clock: deps.clock },
      ),
    )
  }
  return report
}
