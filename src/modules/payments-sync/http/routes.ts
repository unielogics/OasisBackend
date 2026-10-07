// Squarespace integration HTTP API (backend design 5.4 / 5.6, permissions per 6.1). The integration settings (status, connection,
// product map, sync-now, alerts) need set.billing; working the manual matching queue needs pay.collect (the people who take
// payments), and matching or ignoring is money-effecting so it needs an Idempotency-Key. The API key is accepted once, stored
// encrypted and never returned by any route.
import { sql } from 'kysely'
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import type { AppInstance } from '../../../http/types.js'
import type { z } from '../../../http/zod.js'
import { SquarespaceApiError } from '../../../integrations/squarespace/errors.js'
import * as audit from '../../../platform/audit.js'
import { AppError } from '../../../platform/errors.js'
import { maskEmail, maskPhone } from '../../../platform/phone.js'

import { canSeeContact } from '../../people/redact.js'
import { ensurePlans, loadPlans } from '../../memberships/plans.js'
import { syncMemberships } from '../../memberships/service.js'
import { membershipConfigFromEnv } from '../../memberships/jobs.js'
import { listOpenAlerts, resolveAlerts } from '../db/alerts.js'
import { ConnectionStore } from '../db/connection.js'
import { setManualLink } from '../db/links.js'
import { manualIgnore, manualMatch, listOrders, reopenUnmapped } from '../db/manual.js'
import '../db/problems.js'
import {
  buildProductMap,
  listProductRows,
  replaceProductRows,
  seenProducts,
  validateProductInputs,
} from '../db/product-map.js'
import { createSqspRuntime } from '../db/runtime-config.js'
import { SqspLedgerOps } from '../db/ledger.js'
import { secretBoxFromEnv } from '../db/secrets.js'
import { runSyncJob } from '../jobs/sync.js'
import { ProductMap } from '../product-map.js'
import {
  AlertParams,
  Connection,
  ConnectionBody,
  EmptyBody,
  IgnoreBody,
  IgnoreResult,
  LinkBody,
  LinkParams,
  LinkResult,
  MatchBody,
  MatchResult,
  OrderParams,
  OrdersQuery,
  OrdersResult,
  ProductMapBody,
  ProductMapResult,
  ResolveResult,
  Status,
  SyncNowBody,
  SyncNowResult,
} from './schemas.js'

const TAG = 'squarespace'

export function registerSqspRoutes(app: AppInstance): void {
  const auth = (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth
  }
  const runtime = () => createSqspRuntime({ db: app.db, clock: app.clock, newId: app.newId, env: app.env })
  const idem = (fn: Parameters<typeof idempotentHandler<FastifyRequest>>[0]): never =>
    idempotentHandler(fn) as never
  const connView = (rt: ReturnType<typeof runtime>) => ({
    apiKey: rt.d.env.SQSP_API_KEY,
    provider: rt.d.env.SQSP_PROVIDER,
  })
  const lag = (at: Date | null | undefined, now: Date): number | null =>
    at ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000)) : null

  const manualDeps = (locationId: string) => {
    const rt = runtime()
    return {
      locationId,
      clock: app.clock,
      newId: app.newId,
      ops: new SqspLedgerOps({ locationId, clock: app.clock, newId: app.newId }),
      varianceAlertCents: rt.d.env.SQSP_VARIANCE_ALERT_CENTS,
    }
  }
  const actorOf = (req: FastifyRequest) => {
    const a = auth(req)
    return {
      userId: a.realUserId ?? a.userId,
      employeeId: a.employeeId,
      name: a.actorName ?? 'Unknown',
      audit: auditContextOf(req),
    }
  }

  // --- status ---------------------------------------------------------------------------------------------------------

  app.get(
    '/integrations/squarespace/status',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Squarespace connection, last poll, lag, counts and open alerts',
        description:
          'Never contains the API key. `lagSeconds` is the time since the orders poll last succeeded. `counts.deadLetters` are items that failed to map or persist 5 times.',
        response: { 200: Status },
      },
    },
    async (req) => {
      const a = auth(req)
      const loc = a.locationId
      const now = app.clock.now()
      const rt = runtime()
      const conn = await rt.connection(loc).view(connView(rt))
      const states = await app.db
        .selectFrom('sqsp_sync_state')
        .selectAll()
        .where('location_id', '=', loc)
        .execute()
      const resource = (r: 'orders' | 'transactions' | 'contacts' | 'reconcile') => {
        const s = states.find((x) => x.resource === r)
        return {
          status: s?.status ?? 'never_run',
          watermark: s?.watermark?.toISOString() ?? null,
          lastRunAt: s?.last_run_at?.toISOString() ?? null,
          lastSuccessAt: s?.last_success_at?.toISOString() ?? null,
          lagSeconds: lag(s?.last_success_at, now),
          consecutiveFailures: s?.consecutive_failures ?? 0,
          lastError: s?.last_error ?? null,
        }
      }
      const orderRows = await app.db
        .selectFrom('sqsp_orders')
        .select(['match_state', sql<number>`count(*)::int`.as('n')])
        .where('location_id', '=', loc)
        .groupBy('match_state')
        .execute()
      const txnRows = await app.db
        .selectFrom('sqsp_transactions')
        .select(['state', sql<number>`count(*)::int`.as('n')])
        .where('location_id', '=', loc)
        .groupBy('state')
        .execute()
      const queue = await sql<{ n: number }>`
        select count(distinct sqsp_order_id)::int as n from sqsp_manual_queue where location_id = ${loc} and state = 'open'`.execute(
        app.db,
      )
      const awaiting = await sql<{ n: number; cents: number }>`
        select count(*)::int as n, coalesce(sum(e.amount_cents), 0)::bigint as cents
        from ledger_events e
        where e.location_id = ${loc} and e.processor_state = 'awaiting_processor'
          and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)`.execute(app.db)
      const dead = await sql<{ n: number }>`
        select count(*)::int as n from sqsp_sync_errors
        where location_id = ${loc} and resolved_at is null and dead_lettered_at is not null`.execute(app.db)
      const subs = await sql<{ n: number; last: Date | null; secrets: number }>`
        select count(*)::int as n, max(last_delivery_at) as last, count(secret_enc)::int as secrets
        from sqsp_webhook_subscriptions where location_id = ${loc}`.execute(app.db)
      const map = await buildProductMap(app.db, loc, rt.d.env.SQSP_PRODUCT_MAP)
      const cnt = (rows: { n: number; [k: string]: unknown }[], key: string, v: string) =>
        rows.find((r) => r[key] === v)?.n ?? 0
      const orders = resource('orders')
      return {
        provider: rt.d.env.SQSP_PROVIDER,
        pollIntervalSeconds: rt.d.env.SQSP_POLL_INTERVAL_SECONDS,
        connection: conn,
        sync: {
          orders,
          transactions: resource('transactions'),
          contacts: resource('contacts'),
          reconcile: resource('reconcile'),
        },
        lagSeconds: orders.lagSeconds,
        counts: {
          orders: {
            unmatched: cnt(orderRows, 'match_state', 'unmatched'),
            auto: cnt(orderRows, 'match_state', 'auto'),
            manual: cnt(orderRows, 'match_state', 'manual'),
            ignored: cnt(orderRows, 'match_state', 'ignored'),
            membership: cnt(orderRows, 'match_state', 'membership'),
          },
          transactions: {
            new: cnt(txnRows, 'state', 'new'),
            matched: cnt(txnRows, 'state', 'matched'),
            manual: cnt(txnRows, 'state', 'manual'),
            ignored: cnt(txnRows, 'state', 'ignored'),
            deferred: cnt(txnRows, 'state', 'deferred'),
            membership: cnt(txnRows, 'state', 'membership'),
          },
          manualQueueOpen: queue.rows[0]?.n ?? 0,
          awaitingProcessor: { count: awaiting.rows[0]?.n ?? 0, cents: Number(awaiting.rows[0]?.cents ?? 0) },
          deadLetters: dead.rows[0]?.n ?? 0,
        },
        productMap: { entries: map.size, empty: map.size === 0 },
        webhook: {
          subscriptions: subs.rows[0]?.n ?? 0,
          lastDeliveryAt: subs.rows[0]?.last?.toISOString() ?? null,
          secretConfigured: Boolean(rt.d.env.SQSP_WEBHOOK_SECRET) || (subs.rows[0]?.secrets ?? 0) > 0,
        },
        alerts: (await listOpenAlerts(app.db, loc, 50)).map((x) => ({
          ...x,
          variance: x.variance ?? null,
          createdAt: x.createdAt.toISOString(),
        })),
      }
    },
  )

  // --- sync now -------------------------------------------------------------------------------------------------------

  app.post(
    '/integrations/squarespace/sync-now',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Run a Squarespace sync now (queued on the worker, or inline when there is no queue)',
        description:
          '`resume` clears a dead-lettered resource first; `rematch` gives the matcher another chance at the manual queue. Idempotent: a sync already queued is not queued twice.',
        body: SyncNowBody,
        response: { 200: SyncNowResult, 202: SyncNowResult },
      },
    },
    async (req, reply) => {
      const a = auth(req)
      const b = req.body as z.infer<typeof SyncNowBody>
      const rt = runtime()
      if (!(await rt.resolveKey(a.locationId))) throw new AppError('SQSP_NOT_CONFIGURED')
      await app.db.transaction().execute((tx) =>
        audit.record(tx, {
          locationId: a.locationId,
          action: 'sqsp.sync_now',
          entityType: 'integration',
          entityId: 'squarespace',
          after: { resume: b.resume ?? false, rematch: b.rematch ?? false },
          ctx: auditContextOf(req),
        }),
      )
      if (app.jobs) {
        const id = await app.jobs.enqueue('sqsp.sync', b, {
          singletonKey: `sync-now:${b.resume ? 'r' : ''}${b.rematch ? 'm' : ''}`,
        })
        reply.status(202)
        return { mode: 'queued' as const, queued: id !== null, result: null }
      }
      const r = await runSyncJob(app.db, app.clock, a.locationId, { ...b, env: app.env })
      return {
        mode: 'inline' as const,
        queued: false,
        result: {
          status: r.status,
          ordersSeen: r.orders?.seen ?? 0,
          ordersChanged: r.ordersChanged,
          matched: {
            ordersProcessed: r.match?.ordersProcessed ?? 0,
            confirmedAwaiting: r.match?.confirmedAwaiting ?? 0,
            paymentsRecorded: r.match?.paymentsRecorded ?? 0,
            externalRefunds: r.match?.externalRefunds ?? 0,
            manual: r.match?.manual ?? 0,
            ignored: r.match?.ignored ?? 0,
            membership: r.match?.membership ?? 0,
          },
        },
      }
    },
  )

  // --- connection -----------------------------------------------------------------------------------------------------

  app.put(
    '/integrations/squarespace/connection',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Store the Squarespace API key (encrypted); verify it with one read first',
        description:
          'The key needs Orders, Transactions and Contacts read-only permissions (Commerce Advanced plan). It is stored AES-256-GCM encrypted with SECRETS_KEY and is never returned. The response is the connection view.',
        body: ConnectionBody,
        response: { 200: Connection },
      },
    },
    async (req) => {
      const a = auth(req)
      const b = req.body as z.infer<typeof ConnectionBody>
      const rt = runtime()
      const box = secretBoxFromEnv(rt.d.env)
      if (b.verify) {
        const now = app.clock.now()
        try {
          await rt.sourceFor(a.locationId, b.apiKey).listOrders({
            modifiedAfter: new Date(now.getTime() - 3_600_000),
            modifiedBefore: now,
          })
        } catch (e) {
          const detail =
            e instanceof SquarespaceApiError && (e.status === 401 || e.status === 403 || e.status === 402)
              ? `Squarespace answered ${e.status}. Check that the key is current and has read access to Orders, Transactions and Contacts`
              : 'Squarespace could not be reached with that key. Try again in a moment'
          throw new AppError('SQSP_CONNECTION_FAILED', { detail })
        }
      }
      const store = new ConnectionStore(app.db, {
        locationId: a.locationId,
        clock: app.clock,
        newId: app.newId,
        secrets: () => box,
      })
      await app.db.transaction().execute(async (tx) => {
        await new ConnectionStore(tx, {
          locationId: a.locationId,
          clock: app.clock,
          newId: app.newId,
          secrets: () => box,
        }).save(b.apiKey, { userId: a.realUserId ?? a.userId, siteId: b.siteId, verified: b.verify })
        await audit.record(tx, {
          locationId: a.locationId,
          action: 'sqsp.connection_saved',
          entityType: 'integration',
          entityId: 'squarespace',
          after: { authKind: 'api_key', verified: b.verify, siteId: b.siteId ?? null },
          ctx: auditContextOf(req),
        })
      })
      return store.view(connView(rt))
    },
  )

  app.delete(
    '/integrations/squarespace/connection',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Disconnect Squarespace: the stored key is erased and polling stops',
        response: { 200: Connection },
      },
    },
    async (req) => {
      const a = auth(req)
      const rt = runtime()
      const store = new ConnectionStore(app.db, {
        locationId: a.locationId,
        clock: app.clock,
        newId: app.newId,
        secrets: () => secretBoxFromEnv(rt.d.env),
      })
      await app.db.transaction().execute(async (tx) => {
        await new ConnectionStore(tx, {
          locationId: a.locationId,
          clock: app.clock,
          newId: app.newId,
          secrets: () => secretBoxFromEnv(rt.d.env),
        }).disconnect()
        await audit.record(tx, {
          locationId: a.locationId,
          action: 'sqsp.connection_removed',
          entityType: 'integration',
          entityId: 'squarespace',
          ctx: auditContextOf(req),
        })
      })
      return store.view(connView(rt))
    },
  )

  // --- product map ----------------------------------------------------------------------------------------------------

  const productMapResult = async (locationId: string, reopened: number) => {
    const rt = runtime()
    await ensurePlans(app.db, { locationId, clock: app.clock, newId: app.newId })
    const map = await buildProductMap(app.db, locationId, rt.d.env.SQSP_PRODUCT_MAP)
    const plans = await loadPlans(app.db, locationId)
    const envEntries = (() => {
      try {
        return ProductMap.fromJson(rt.d.env.SQSP_PRODUCT_MAP).size
      } catch {
        return 0
      }
    })()
    return {
      entries: await listProductRows(app.db, locationId),
      environmentEntries: envEntries,
      seen: await seenProducts(
        app.db,
        locationId,
        new Date(app.clock.now().getTime() - 90 * 86_400_000),
        map,
      ),
      plans: plans.map((p) => ({ key: p.key, name: p.name })),
      reopenedOrders: reopened,
    }
  }

  app.get(
    '/integrations/squarespace/product-map',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'The Squarespace product map and the products seen on recent orders (mapped or not)',
        description:
          'Squarespace has no subscription flag or tier on an order: this map is the only source of "this product is a Premium membership" and "this order is one of ours". `seen` lists the last 90 days so unmapped products are visible.',
        response: { 200: ProductMapResult },
      },
    },
    async (req) => productMapResult(auth(req).locationId, 0),
  )

  app.put(
    '/integrations/squarespace/product-map',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Replace the product map',
        description:
          'The body is the complete map (rows matched by product id, then SKU). A membership needs a plan (or a plan label naming one, e.g. "Premium Care" is Premium). Orders that were ignored only because no product was mapped become unmatched again.',
        body: ProductMapBody,
        response: { 200: ProductMapResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const b = req.body as z.infer<typeof ProductMapBody>
      await ensurePlans(app.db, { locationId: a.locationId, clock: app.clock, newId: app.newId })
      const issues = await validateProductInputs(app.db, a.locationId, b.entries)
      if (issues.length)
        throw new AppError('VALIDATION_FAILED', {
          errors: issues.map((i) => ({ path: `entries.${i.index}.${i.path}`, message: i.message })),
        })
      let reopened = 0
      await app.db.transaction().execute(async (tx) => {
        const d = { locationId: a.locationId, clock: app.clock, newId: app.newId }
        const before = await listProductRows(tx, a.locationId)
        const rows = await replaceProductRows(tx, d, b.entries)
        reopened = (await reopenUnmapped(tx, d)).orders
        if (rows.length > 0 || runtime().d.env.SQSP_PRODUCT_MAP)
          await resolveAlerts(tx, d, ['product_map_empty'], { by: a.userId })
        await audit.record(tx, {
          locationId: a.locationId,
          action: 'sqsp.product_map_saved',
          entityType: 'integration',
          entityId: 'squarespace',
          before: { entries: before.length },
          after: { entries: rows.length, reopenedOrders: reopened },
          ctx: auditContextOf(req),
        })
      })
      if (reopened > 0)
        await app.jobs?.enqueue('sqsp.sync', {}, { singletonKey: 'after-product-map' }).catch(() => null)
      return productMapResult(a.locationId, reopened)
    },
  )

  // --- orders and manual matching -------------------------------------------------------------------------------------

  app.get(
    '/integrations/squarespace/orders',
    {
      config: { access: access.anyPerm('set.billing', 'pay.collect') },
      schema: {
        tags: [TAG],
        summary: 'Synced Squarespace orders by match state (default: those that need a person)',
        description:
          '`state=unmatched` lists orders the matcher has not matched yet plus those waiting in the manual queue, each with its payments and refunds and the queue reasons with scored suggestions. Contact details are masked without cli.contact.',
        querystring: OrdersQuery,
        response: { 200: OrdersResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const q = req.query
      const page = await listOrders(app.db, a.locationId, q)
      const unmasked = canSeeContact(a)
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((o) => ({
          ...o,
          customerEmail: o.customerEmail && !unmasked ? maskEmail(o.customerEmail) : o.customerEmail,
          customerPhone: o.customerPhone && !unmasked ? maskPhone(o.customerPhone) : o.customerPhone,
        })),
      }
    },
  )

  app.post(
    '/integrations/squarespace/orders/:id/match',
    {
      config: { access: access.perm('pay.collect'), idempotency: 'required' as const },
      schema: {
        tags: [TAG],
        summary: 'Match an order’s payments to an invoice or to a card payment waiting on Squarespace',
        description:
          'With `eventId` (a staff-recorded card payment or refund awaiting Squarespace) the entry is confirmed. With `invoiceId` the payment is recorded as a `squarespace` pay event, refused (409) when the invoice already shows a waiting or equal card payment unless `force`. Uses the same idempotency keys as the matcher, so a later poll never counts the money twice.',
        params: OrderParams,
        body: MatchBody,
        response: { 200: MatchResult },
      },
    },
    idem(async (req, tx) => {
      const a = auth(req)
      const b = req.body as z.infer<typeof MatchBody>
      return {
        status: 200,
        body: await manualMatch(
          tx,
          manualDeps(a.locationId),
          { orderId: (req.params as { id: string }).id, ...b },
          actorOf(req),
        ),
      }
    }),
  )

  app.post(
    '/integrations/squarespace/orders/:id/ignore',
    {
      config: { access: access.perm('pay.collect'), idempotency: 'required' as const },
      schema: {
        tags: [TAG],
        summary: 'Ignore an order (not ours, a test, a duplicate)',
        description:
          'The order and its unmatched payments leave the queue. Refused (409) when money from the order is already on an invoice.',
        params: OrderParams,
        body: IgnoreBody,
        response: { 200: IgnoreResult },
      },
    },
    idem(async (req, tx) => {
      const a = auth(req)
      return {
        status: 200,
        body: await manualIgnore(
          tx,
          manualDeps(a.locationId),
          {
            orderId: (req.params as { id: string }).id,
            reason: (req.body as z.infer<typeof IgnoreBody>).reason,
          },
          actorOf(req),
        ),
      }
    }),
  )

  // --- customer links and alerts --------------------------------------------------------------------------------------

  app.put(
    '/integrations/squarespace/customer-links/:sqspCustomerId',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Link a Squarespace customer to an Oasis customer (for members the sync could not place)',
        description:
          'Squarespace customer ids come from the Contacts feed and from orders. After linking, the membership pass runs so the member appears right away.',
        params: LinkParams,
        body: LinkBody,
        response: { 200: LinkResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const b = req.body as z.infer<typeof LinkBody>
      const cust = await app.db
        .selectFrom('customers')
        .select('id')
        .where('id', '=', b.customerId)
        .where('deleted_at', 'is', null)
        .where('merged_into', 'is', null)
        .executeTakeFirst()
      if (!cust) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
      const d = { locationId: a.locationId, clock: app.clock }
      await app.db.transaction().execute(async (tx) => {
        await setManualLink(tx, d, {
          sqspCustomerId: req.params.sqspCustomerId,
          customerId: b.customerId,
          userId: a.realUserId ?? a.userId,
        })
        await audit.record(tx, {
          locationId: a.locationId,
          action: 'sqsp.customer_linked',
          entityType: 'customer',
          entityId: b.customerId,
          after: { sqspCustomerId: req.params.sqspCustomerId },
          ctx: auditContextOf(req),
        })
      })
      const rt = runtime()
      const r = await syncMemberships(app.db, {
        locationId: a.locationId,
        clock: app.clock,
        newId: app.newId,
        productMap: await buildProductMap(app.db, a.locationId, rt.d.env.SQSP_PRODUCT_MAP),
        config: membershipConfigFromEnv(rt.d.env),
      })
      return {
        sqspCustomerId: req.params.sqspCustomerId,
        customerId: b.customerId,
        membershipsCreated: r.created,
        membershipsUpdated: r.updated,
      }
    },
  )

  app.post(
    '/integrations/squarespace/alerts/:id/resolve',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Mark a sync alert as handled',
        params: AlertParams,
        body: EmptyBody,
        response: { 200: ResolveResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const r = await sql`
        update sqsp_alerts set resolved_at = ${app.clock.now()}, resolved_by = ${a.realUserId ?? a.userId}
        where id = ${req.params.id} and location_id = ${a.locationId} and resolved_at is null`.execute(app.db)
      return { resolved: Number(r.numAffectedRows ?? 0) > 0 }
    },
  )
}
