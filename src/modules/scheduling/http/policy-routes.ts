// GET/PUT /settings/cancellation-policy: what cancel and no-show do with the money held on an invoice (ADR 0082). The values
// live in the settings registry (`cancellation.policy`); this is its only editor, next to the booking rules (set.hours).
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import type { AppInstance } from '../../../http/types.js'
import { AppError } from '../../../platform/errors.js'
import { transaction } from '../../../platform/db.js'
import { getSetting, updateSetting } from '../../../platform/settings.js'

const Policy = z.object({
  freeCancelHours: z
    .number()
    .int()
    .min(0)
    .max(720)
    .describe('Cancelling at least this many hours before the start refunds the held money in full'),
  lateRetainBp: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe(
      'Inside that window, the share of the held money that is kept, in basis points (10000 = all, 0 = none)',
    ),
  noShowRetainBp: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe('The share kept on a no-show, in basis points'),
  refundTo: z
    .enum(['original', 'credit'])
    .describe('Where a policy refund goes: the original tender, or store credit'),
})

const Reply = z.object({ policy: Policy, version: z.number().int() })

export function registerPolicyRoutes(app: AppInstance): void {
  const loc = (req: { auth: { locationId: string } | null }): string => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth.locationId
  }
  app.get(
    '/settings/cancellation-policy',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        summary: 'The cancellation and no-show deposit policy',
        description:
          'version 0 means the defaults have never been saved: 24 h free cancellation, deposits kept inside it and on a no-show, refunds to the original tender.',
        response: { 200: Reply },
      },
    },
    async (req) => {
      const r = await getSetting(app.db, loc(req), 'cancellation.policy')
      return { policy: r.value, version: r.version }
    },
  )
  app.put(
    '/settings/cancellation-policy',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        summary: 'Save the cancellation and no-show deposit policy',
        description:
          'Send the version you read; a stale one answers 412 VERSION_CONFLICT. Applies to cancels and no-shows from now on.',
        body: Policy.extend({ version: z.number().int().min(0) }).strict(),
        response: { 200: Reply },
      },
    },
    async (req) => {
      const { version, ...policy } = req.body
      const saved = await transaction(app.db, (tx) =>
        updateSetting(tx, {
          locationId: loc(req),
          key: 'cancellation.policy',
          value: policy,
          expectedVersion: version,
          updatedBy: req.auth?.realUserId ?? req.auth?.userId ?? null,
          audit: auditContextOf(req),
        }),
      )
      return { policy: saved.value, version: saved.version }
    },
  )
}
