// Device administration (set.billing): the SMS tablets, their credentials (stored encrypted, never returned), a connection
// test, webhook registration and the health panel behind the Needs Attention card.
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import * as audit from '../../../platform/audit.js'
import { transaction } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { SmsProviderError } from '../../../integrations/sms/errors.js'
import { deviceView, type DeviceRow } from '../db/devices.js'
import { isQuietHour, quietHoursEnd } from '../policy/quietHours.js'
import type { MessagingRuntime } from '../runtime.js'
import './problems.js'

const TAGS = ['integrations']
const IdParams = z.object({ id: z.string().uuid() })

const Device = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  provider: z.enum(['sim', 'smsgate']),
  baseUrl: z.string().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  simSlotDefault: z.number().int().nullable(),
  minIntervalMs: z.number().int().nullable(),
  maxPerWindow: z.number().int().nullable(),
  windowMinutes: z.number().int().nullable(),
  enabled: z.boolean(),
  status: z.enum(['unknown', 'online', 'degraded', 'offline']),
  stateChangedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  lastPingAt: z.string().nullable(),
  lastAppStartedAt: z.string().nullable(),
  lastPollOkAt: z.string().nullable(),
  consecutivePollFailures: z.number().int(),
  healthStatus: z.enum(['pass', 'warn', 'fail']).nullable(),
  battery: z.number().int().nullable(),
  charging: z.boolean().nullable(),
  lastError: z.string().nullable(),
  webhooksUrl: z.string().nullable(),
  webhooksRegisteredAt: z.string().nullable(),
  counters: z.object({ sent: z.number(), delivered: z.number(), failed: z.number(), received: z.number() }),
  /** The address the tablet should call; null until SMSGATE_WEBHOOK_PUBLIC_URL is set. */
  webhookUrl: z.string().nullable(),
})

const Limits = {
  simSlotDefault: z.number().int().min(1).max(3).nullable().optional(),
  minIntervalMs: z.number().int().min(0).max(600_000).nullable().optional(),
  maxPerWindow: z.number().int().min(1).max(1000).nullable().optional(),
  windowMinutes: z.number().int().min(1).max(1440).nullable().optional(),
}

const CreateBody = z
  .object({
    label: z.string().trim().min(1).max(80),
    provider: z.enum(['sim', 'smsgate']).default('smsgate'),
    baseUrl: z.string().url().optional(),
    username: z.string().min(1).max(200).optional(),
    password: z.string().min(1).max(500).optional(),
    webhookSecret: z.string().min(8).max(200).optional(),
    enabled: z.boolean().optional(),
    ...Limits,
  })
  .strict()

const PatchBody = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    baseUrl: z.string().url().nullable().optional(),
    username: z.string().min(1).max(200).nullable().optional(),
    password: z.string().min(1).max(500).nullable().optional(),
    webhookSecret: z.string().min(8).max(200).optional(),
    enabled: z.boolean().optional(),
    ...Limits,
  })
  .strict()

export function registerDeviceRoutes(app: AppInstance, rt: MessagingRuntime): void {
  const out = (d: DeviceRow): z.infer<typeof Device> => ({
    ...deviceView(d),
    webhookUrl: rt.webhookUrlFor(d),
  })

  const find = async (locationId: string, id: string): Promise<DeviceRow> => {
    const d = await rt.store.get(id)
    if (!d || d.location_id !== locationId) throw new AppError('NOT_FOUND')
    return d
  }

  app.get(
    '/integrations/sms/devices',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'The SMS devices and their health',
        response: { 200: z.object({ items: z.array(Device) }) },
      },
    },
    async (req) => ({ items: (await rt.store.list(req.auth!.locationId)).map(out) }),
  )

  app.post(
    '/integrations/sms/devices',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'Add an SMS device',
        description:
          "An SMS Gate device needs its tailnet URL, username and password. The webhook signing secret is generated when omitted and returned ONCE here (set the same value in the app's Webhooks settings); credentials are stored encrypted with SECRETS_KEY and never shown again. `provider: sim` adds an in-process simulator device.",
        body: CreateBody,
        response: { 201: z.object({ device: Device, webhookSecret: z.string() }) },
      },
    },
    async (req, reply) => {
      const r = await transaction(app.db, async (tx) => {
        const created = await rt.store.forExecutor(tx).create(req.auth!.locationId, req.body)
        await audit.record(tx, {
          locationId: req.auth!.locationId,
          action: 'sms_device.create',
          entityType: 'sms_device',
          entityId: created.device.id,
          after: { label: created.device.label, provider: created.device.provider },
          ctx: auditContextOf(req),
        })
        return created
      })
      void reply.code(201)
      return { device: out(r.device), webhookSecret: r.webhookSecret }
    },
  )

  app.patch(
    '/integrations/sms/devices/:id',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'Edit a device: label, credentials, limits, enabled',
        description:
          'A password or webhook secret that is sent replaces the stored one; omitted secrets are kept.',
        params: IdParams,
        body: PatchBody,
        response: { 200: Device },
      },
    },
    async (req) => {
      const before = await find(req.auth!.locationId, req.params.id)
      const next = await rt.store.update(before.id, req.body)
      rt.providers.forget(before.id)
      await transaction(app.db, (tx) =>
        audit.record(tx, {
          locationId: before.location_id,
          action: 'sms_device.update',
          entityType: 'sms_device',
          entityId: before.id,
          after: { fields: Object.keys(req.body).filter((k) => k !== 'password' && k !== 'webhookSecret') },
          ctx: auditContextOf(req),
        }),
      )
      return out(next ?? before)
    },
  )

  app.post(
    '/integrations/sms/devices/:id/test',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'Check the connection: health poll and a credentials probe (nothing is sent)',
        params: IdParams,
        response: {
          200: z.object({
            reachable: z.boolean(),
            credentials: z.enum(['ok', 'rejected', 'unknown']),
            healthStatus: z.string().nullable(),
            battery: z.number().int().nullable(),
            error: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const d = await find(req.auth!.locationId, req.params.id)
      const provider = rt.providers.forDevice(d)
      const health = await provider.health()
      const details = (health.details ?? {}) as { reachable?: boolean; status?: string; error?: string }
      const reachable = details.reachable ?? health.ok
      let credentials: 'ok' | 'rejected' | 'unknown' = 'unknown'
      let error: string | null = details.error ?? null
      if (reachable) {
        try {
          await provider.status('oasis-connection-test')
          credentials = 'ok'
        } catch (err) {
          if (err instanceof SmsProviderError && err.kind === 'auth') credentials = 'rejected'
          error = (err as Error).message
        }
      }
      return {
        reachable,
        credentials,
        healthStatus: details.status ?? null,
        battery: health.battery ?? null,
        error,
      }
    },
  )

  app.post(
    '/integrations/sms/devices/:id/register-webhooks',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary:
          'Register the seven oasis-* webhooks on the device (idempotent; stale oasis-* ones are removed)',
        params: IdParams,
        response: {
          200: z.object({
            registered: z.boolean(),
            url: z.string().nullable(),
            error: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const d = await find(req.auth!.locationId, req.params.id)
      const r = await rt.registerWebhooks(d)
      await transaction(app.db, (tx) =>
        audit.record(tx, {
          locationId: d.location_id,
          action: 'sms_device.register_webhooks',
          entityType: 'sms_device',
          entityId: d.id,
          after: { registered: r.registered },
          ctx: auditContextOf(req),
        }),
      )
      return { registered: r.registered, url: r.url, error: r.error ?? null }
    },
  )

  const Lane = z.number().int()
  app.get(
    '/integrations/sms/devices/:id/health',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'Device health and what the dispatcher is doing',
        description:
          '`refresh=true` polls the device first. `dispatch.state` is idle, sending, rate_limited, quiet_hours or device_offline; `budget` is the sliding send window (segments used and left, lane 0 may use the reserved part).',
        params: IdParams,
        querystring: z.object({ refresh: z.coerce.boolean().default(false) }),
        response: {
          200: z.object({
            device: Device,
            dispatch: z.object({
              state: z.enum(['idle', 'sending', 'rate_limited', 'quiet_hours', 'device_offline']),
              rateLimited: z.boolean(),
              resumesAt: z.string().nullable(),
              heldByQuietHours: z.number().int(),
              budget: z.object({
                used: z.number().int(),
                max: z.number().int(),
                reservedForP0: z.number().int(),
                remainingP0: z.number().int(),
                remainingOthers: z.number().int(),
                windowMinutes: z.number().int(),
              }),
              queue: z.object({
                depth: z.number().int(),
                byLane: z.record(z.string(), Lane),
                oldestQueuedAt: z.string().nullable(),
                etaFirst: z.string().nullable(),
                etaLast: z.string().nullable(),
                willExpire: z.number().int(),
              }),
            }),
            quietHours: z.object({
              enabled: z.boolean(),
              active: z.boolean(),
              endsAt: z.string().nullable(),
            }),
            failedLast24h: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      let d = await find(req.auth!.locationId, req.params.id)
      if (req.query.refresh) {
        await rt.pollHealth(d)
        d = await find(req.auth!.locationId, req.params.id)
      }
      const { dispatcher } = rt.dispatcherFor(d)
      const s = await dispatcher.status()
      const now = app.clock.now()
      const quiet = rt.config.plan.quietHours
      const active = isQuietHour(now, quiet)
      const failed = await app.db
        .selectFrom('sms_outbox')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('state', '=', 'failed')
        .where('failed_at', '>=', new Date(now.getTime() - 86_400_000))
        .where((eb) => eb.or([eb('device_id', '=', d.id), eb('device_id', 'is', null)]))
        .executeTakeFirstOrThrow()
      return {
        device: out(d),
        dispatch: {
          state: s.state,
          rateLimited: s.rateLimited,
          resumesAt: s.resumesAt ? s.resumesAt.toISOString() : null,
          heldByQuietHours: s.heldByQuietHours,
          budget: {
            used: s.budget.used,
            max: s.budget.max,
            reservedForP0: s.budget.reservedForP0,
            remainingP0: s.budget.remainingP0,
            remainingOthers: s.budget.remainingOthers,
            windowMinutes: Math.round(s.budget.windowMs / 60_000),
          },
          queue: {
            depth: s.queue.depth,
            byLane: Object.fromEntries(Object.entries(s.queue.byLane).map(([k, v]) => [k, v])),
            oldestQueuedAt: s.queue.oldestQueuedAt ? s.queue.oldestQueuedAt.toISOString() : null,
            etaFirst: s.queue.etaFirst ? s.queue.etaFirst.toISOString() : null,
            etaLast: s.queue.etaLast ? s.queue.etaLast.toISOString() : null,
            willExpire: s.queue.willExpire,
          },
        },
        quietHours: {
          enabled: quiet.enabled,
          active,
          endsAt: active ? quietHoursEnd(now, quiet).toISOString() : null,
        },
        failedLast24h: Number(failed.n),
      }
    },
  )
}
