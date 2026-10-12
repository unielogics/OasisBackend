// GET /integrations/square and POST /integrations/square/test (ADR 0171, api-spec section 30). The test calls Square (or, with
// SQUARE_PROVIDER=sim, the in-process simulator): ListLocations, EnableEvents and the webhook subscription check; it stores the
// merchant id the hook checks deliveries against, and is audited. No route here ever returns a token or a signature key.
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import type { z } from '../../../http/zod.js'
import { SQUARE_EVENT_TYPES } from '../../../integrations/square/webhook.js'
import * as audit from '../../../platform/audit.js'
import { AppError } from '../../../platform/errors.js'
import { testSquareConnection } from '../connection.js'
import { currentSquareState, saveSquareState, squareEnvironment } from '../db/state.js'
import { squareApi } from '../runtime.js'
import { squareStatus } from '../status.js'
import { SquareIntegrationView, SquareTestResult } from './schemas.js'

const TAG = 'square'

/** The body of GET /integrations/square (also the `square` block of GET /settings/billing). */
export async function squareIntegrationView(app: AppInstance, locationId: string): Promise<z.infer<typeof SquareIntegrationView>> {
  const now = app.clock.now()
  const state = await currentSquareState(app.db, locationId, app.env)
  const test = state?.last_test ?? null
  const rec = state?.last_reconcile ?? null
  return {
    status: await squareStatus(app.db, app.env, now),
    eventTypes: [...SQUARE_EVENT_TYPES],
    lastTest: test && state?.last_test_at ? { ok: test.ok, at: state.last_test_at.toISOString(), checks: test.checks as never } : null,
    catchup: {
      watermark: state?.watermark?.toISOString() ?? null,
      lastRunAt: state?.last_catchup_at?.toISOString() ?? null,
      lastEvents: state?.last_catchup_events ?? 0,
    },
    reconcile: rec && state?.last_reconcile_at ? { at: state.last_reconcile_at.toISOString(), ...rec } : null,
  }
}

export function registerSquareRoutes(app: AppInstance): void {
  const loc = (req: FastifyRequest): string => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth.locationId
  }

  app.get(
    '/integrations/square',
    {
      config: { access: access.anyPerm('set.billing', 'pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'Square: the status row, the last connection test, the catch-up and the last reconcile',
        description:
          'The same status row as GET /system/integrations (`square`), plus the event types our webhook subscription must carry, the last Test connection, the Events API catch-up watermark and the counts of the last nightly reconcile. Never contains the token or a signature key.',
        response: { 200: SquareIntegrationView },
      },
    },
    async (req) => squareIntegrationView(app, loc(req)),
  )

  app.post(
    '/integrations/square/test',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: [TAG],
        summary: 'Test the Square connection: token, location, Events API, webhook subscription',
        description:
          'Calls ListLocations (the token works; SQUARE_LOCATION_ID is active, in USD and takes cards), EnableEvents, and ListWebhookSubscriptions (a subscription for SQUARE_WEBHOOK_URL carries every event type of `GET /integrations/square`). Stores the merchant id that /hooks/square checks deliveries against. With SQUARE_PROVIDER=sim it talks to the in-process simulator. A failed check is a 200 with `ok: false` and the check\'s plain-language detail. Audited (`square.test_connection`).',
        response: { 200: SquareTestResult },
      },
    },
    async (req) => {
      const locationId = loc(req)
      const env = app.env
      const r = await testSquareConnection(squareApi(env), env)
      const now = app.clock.now()
      const failed = r.checks.find((c) => !c.ok)
      await app.db.transaction().execute(async (tx) => {
        await saveSquareState(tx, locationId, env, now, {
          square_location_id: r.locationId,
          ...(r.merchantId ? { merchant_id: r.merchantId } : {}),
          ...(r.eventsEnabled ? { events_enabled_at: now } : {}),
          webhook_subscription_id: r.webhookSubscriptionId,
          webhook_checked_at: now,
          last_test_at: now,
          last_test: { ok: r.ok, at: now.toISOString(), checks: r.checks },
          ...(failed ? { last_error: `test connection: ${failed.detail}`, last_error_at: now } : {}),
        })
        await audit.record(tx, {
          locationId,
          action: 'square.test_connection',
          entityType: 'integration',
          entityId: 'square',
          after: { ok: r.ok, environment: squareEnvironment(env), checks: r.checks.map((c) => ({ key: c.key, ok: c.ok })) },
          ctx: auditContextOf(req),
        })
      })
      return {
        ok: r.ok,
        environment: squareEnvironment(env),
        locationId: r.locationId,
        merchantId: r.merchantId,
        webhookSubscriptionId: r.webhookSubscriptionId,
        checks: r.checks,
        testedAt: now.toISOString(),
      }
    },
  )
}
