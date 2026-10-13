// POST /hooks/square (ADR 0171): Square's webhook. The signature is base64 HMAC-SHA256(key, SQUARE_WEBHOOK_URL + raw body), checked in
// constant time against the current key and, during a rotation, the previous one; the URL is the configured one, never the request's.
// An event of a merchant other than ours (learned by the connection test against this same Square environment: a merchant learned
// from the simulator or the sandbox never applies to production) is acknowledged and dropped. The event is claimed in
// webhook_log('square', event_id) with its headers (no signature) and raw body, square.event.process is queued (singleton per event)
// and Square gets 200 at once; a duplicate gets 200 too. A queue that refuses the job releases the claim and answers 503, so Square's
// retry is accepted. The object itself is re-fetched by the job; nothing in the payload is trusted.
import type { ApiModule } from '../../../http/modules.js'
import { webhookRoute } from '../../../http/webhooks.js'
import { SQUARE_SIGNATURE_HEADER, parseSquareEvent, verifySquareSignature } from '../../../integrations/square/webhook.js'
import { AppError } from '../../../platform/errors.js'
import { createIdGenerator } from '../../../platform/ids.js'
import { getDefaultLocation } from '../../../platform/locations.js'
import { currentSquareState, saveSquareState, squareEnvironment } from '../db/state.js'
import { processLoggedEvent, squareWebhookLog } from '../events.js'
import { squareApi, squareIngest } from '../runtime.js'
import '../problems.js'

/** How far before its event the first webhook sets the connection point (a sale is made shortly before its event). */
const CONNECTION_POINT_MARGIN_MS = 10 * 60_000

const KEPT_HEADERS = ['content-type', 'user-agent', 'square-environment', 'square-initial-delivery-timestamp', 'square-retry-number', 'square-retry-reason']

export const squareHookModule: ApiModule = (app, deps) => {
  const newId = deps.newId ?? createIdGenerator(deps.clock)
  const log = squareWebhookLog(deps.db, newId)
  webhookRoute(app, {
    provider: 'square',
    path: '/square',
    handler: async (req, reply) => {
      const env = deps.env
      const raw = req.rawBody ?? ''
      const sig = req.headers[SQUARE_SIGNATURE_HEADER]
      const which = verifySquareSignature({
        notificationUrl: env.SQUARE_WEBHOOK_URL,
        rawBody: raw,
        signature: Array.isArray(sig) ? sig[0] : sig,
        keys: { current: env.SQUARE_WEBHOOK_SIGNATURE_KEY, previous: env.SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS },
      })
      if (!which) throw new AppError('WEBHOOK_SIGNATURE_INVALID')
      const parsed = parseSquareEvent(raw)
      if (!parsed.ok) throw new AppError('MALFORMED_REQUEST', { detail: parsed.reason })
      const event = parsed.event
      const location = await getDefaultLocation(deps.db)
      if (!location) throw new AppError('SERVICE_UNAVAILABLE')
      const state = await currentSquareState(deps.db, location.id, env)
      if (state?.merchant_id && event.merchant_id && event.merchant_id !== state.merchant_id) {
        req.log.warn({ square: { event: event.event_id, type: event.type } }, 'square webhook of another merchant ignored')
        return reply.status(200).send({ status: 'ignored' })
      }
      const now = deps.clock.now()
      const headers: Record<string, string> = { source: 'webhook', key: which }
      for (const h of KEPT_HEADERS) {
        const v = req.headers[h]
        if (v !== undefined) headers[h] = String(Array.isArray(v) ? v[0] : v)
      }
      if (!(await log.claim(event.event_id, now, { headers, body: raw }))) return reply.status(200).send({ status: 'duplicate' })
      // the first webhook of this Square, before anything read it (sandbox run F2): a webhook is live, so the connection point is
      // set a little before the event (a sale made just before its event is not history); the catch-up and reconcile keep it
      const point =
        squareEnvironment(env) !== 'sim' && !state?.connected_at && !state?.watermark
          ? new Date(Math.min(now.getTime(), Date.parse(event.created_at) || now.getTime()) - CONNECTION_POINT_MARGIN_MS)
          : undefined
      await saveSquareState(deps.db, location.id, env, now, { last_webhook_at: now, ...(point ? { connection_point: point } : {}) })
      if (deps.jobs) {
        try {
          await deps.jobs.enqueue('square.event.process', { eventId: event.event_id }, { singletonKey: event.event_id })
        } catch {
          await log.release(event.event_id)
          throw new AppError('SERVICE_UNAVAILABLE')
        }
        return reply.status(200).send({ status: 'accepted' })
      }
      // no queue (a single-process setup): process now; a failure gives the event back so Square's retry is accepted
      try {
        await processLoggedEvent(
          { db: deps.db, clock: deps.clock, logger: req.log, env, api: squareApi(env), ingest: squareIngest(), newId },
          event.event_id,
        )
      } catch {
        await log.release(event.event_id)
        throw new AppError('SERVICE_UNAVAILABLE')
      }
      return reply.status(200).send({ status: 'accepted' })
    },
  })
}
