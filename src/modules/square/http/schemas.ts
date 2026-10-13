import { z } from '../../../http/zod.js'
import { IntegrationStatus } from '../../system/integrations.js'

const iso = z.iso.datetime({ offset: true })

export const SquareCheck = z.object({
  key: z.enum(['token', 'location', 'events', 'webhook', 'tax']).describe('tax: the Square item library’s tax check (ADR 0172); it fails Test connection only while the item sync is on'),
  ok: z.boolean(),
  detail: z.string(),
})

export const SquareTestResult = z.object({
  ok: z.boolean(),
  environment: z.enum(['sandbox', 'production', 'sim']),
  locationId: z.string().nullable(),
  merchantId: z.string().nullable(),
  webhookSubscriptionId: z.string().nullable(),
  checks: z.array(SquareCheck),
  testedAt: iso,
})

export const SquareIntegrationView = z.object({
  status: IntegrationStatus,
  /** The event types our webhook subscription must carry (pnpm square:webhooks --apply sets them). */
  eventTypes: z.array(z.string()),
  lastTest: z
    .object({ ok: z.boolean(), at: iso, checks: z.array(SquareCheck) })
    .nullable(),
  catchup: z.object({
    watermark: iso.nullable(),
    lastRunAt: iso.nullable(),
    lastEvents: z.number().int(),
  }),
  reconcile: z
    .object({
      at: iso,
      from: iso,
      to: iso,
      payments: z.number().int(),
      refunds: z.number().int(),
      paymentsByStatus: z.record(z.string(), z.number().int()),
      refundsByStatus: z.record(z.string(), z.number().int()),
      bySource: z.record(z.string(), z.number().int()),
      byProduct: z.record(z.string(), z.number().int()),
      complete: z.boolean(),
      decided: z.number().int().optional().describe('Payments the reconcile decided itself (missed by the webhook and the catch-up)'),
    })
    .nullable(),
})
