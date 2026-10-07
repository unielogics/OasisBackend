// SMS consent of a customer: read it, and let staff record an opt-in or a manual opt-out. A STOP the customer sent is theirs
// to undo (START); staff cannot lift it.
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import * as audit from '../../../platform/audit.js'
import { transaction, type Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type { MessagingRuntime } from '../runtime.js'
import './problems.js'

const TAGS = ['customers']
const IdParams = z.object({ id: z.string().uuid() })

const Consent = z.object({
  customerId: z.string(),
  smsOptedIn: z.boolean(),
  optInSource: z.string().nullable(),
  optInAt: z.string().nullable(),
  optedOut: z.boolean(),
  optedOutAt: z.string().nullable(),
  /** keyword: the customer texted STOP; manual: staff recorded it. */
  optOutSource: z.enum(['keyword', 'manual', 'import']).nullable(),
  /** False for a keyword opt-out: only the customer can undo it. */
  staffCanClearOptOut: z.boolean(),
  hasPhone: z.boolean(),
})

async function readConsent(
  db: Executor,
  locationId: string,
  customerId: string,
): Promise<z.infer<typeof Consent> | null> {
  const c = await db
    .selectFrom('customers')
    .select(['id', 'phone_e164', 'sms_opted_in', 'sms_opt_in_source', 'sms_opt_in_at', 'sms_opted_out_at'])
    .where('id', '=', customerId)
    .executeTakeFirst()
  if (!c) return null
  const active = c.phone_e164
    ? await db
        .selectFrom('sms_opt_outs')
        .select(['source', 'opted_out_at'])
        .where('location_id', '=', locationId)
        .where('phone_e164', '=', c.phone_e164)
        .where('opted_in_again_at', 'is', null)
        .executeTakeFirst()
    : undefined
  const optedOut = Boolean(active) || c.sms_opted_out_at !== null
  return {
    customerId: c.id,
    smsOptedIn: c.sms_opted_in,
    optInSource: c.sms_opt_in_source,
    optInAt: c.sms_opt_in_at ? c.sms_opt_in_at.toISOString() : null,
    optedOut,
    optedOutAt: (active?.opted_out_at ?? c.sms_opted_out_at)?.toISOString() ?? null,
    optOutSource: active?.source ?? (c.sms_opted_out_at ? 'manual' : null),
    staffCanClearOptOut: !active || active.source !== 'keyword',
    hasPhone: Boolean(c.phone_e164),
  }
}

export function registerConsentRoutes(app: AppInstance, _rt: MessagingRuntime): void {
  app.get(
    '/customers/:id/sms-consent',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: TAGS,
        summary: "A customer's SMS consent: opt-in, opt-out and who can change it",
        params: IdParams,
        response: { 200: Consent },
      },
    },
    async (req) => {
      const c = await readConsent(app.db, req.auth!.locationId, req.params.id)
      if (!c) throw new AppError('NOT_FOUND')
      return c
    },
  )

  app.put(
    '/customers/:id/sms-consent',
    {
      config: { access: access.perm('cli.edit') },
      schema: {
        tags: TAGS,
        summary: 'Record consent: opt in (staff-attested), opt out, or lift a staff opt-out',
        description:
          '`optedIn: true` records staff-attested consent. `optedOut: true` records a manual opt-out (every text to the number stops, emergencies included); `optedOut: false` lifts a MANUAL opt-out only. A STOP the customer texted is refused with 422 SMS_STOP_ACTIVE: they must reply START.',
        params: IdParams,
        body: z
          .object({ optedIn: z.boolean().optional(), optedOut: z.boolean().optional() })
          .strict()
          .refine((b) => b.optedIn !== undefined || b.optedOut !== undefined, {
            message: 'Send optedIn or optedOut',
          }),
        response: { 200: Consent },
      },
    },
    async (req) =>
      transaction(app.db, async (tx) => {
        const locationId = req.auth!.locationId
        const before = await readConsent(tx, locationId, req.params.id)
        if (!before) throw new AppError('NOT_FOUND')
        const customer = await tx
          .selectFrom('customers')
          .select(['phone_e164'])
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        const now = app.clock.now()
        const { optedIn, optedOut } = req.body
        const clearsOptOut = optedOut === false || optedIn === true
        const setsOptOut = optedOut === true

        if (clearsOptOut && before.optedOut && !before.staffCanClearOptOut)
          throw new AppError('SMS_STOP_ACTIVE')
        if (setsOptOut && !customer.phone_e164)
          throw new AppError('SMS_NO_PHONE', { params: { name: 'this customer' } })

        if (clearsOptOut && before.optedOut) {
          if (customer.phone_e164)
            await tx
              .updateTable('sms_opt_outs')
              .set({ opted_in_again_at: now })
              .where('location_id', '=', locationId)
              .where('phone_e164', '=', customer.phone_e164)
              .where('opted_in_again_at', 'is', null)
              .execute()
          await tx
            .updateTable('customers')
            .set((eb) => ({ sms_opted_out_at: null, version: eb('version', '+', 1), updated_at: now }))
            .where('id', '=', req.params.id)
            .execute()
        }
        if (setsOptOut && !before.optedOut) {
          await tx
            .insertInto('sms_opt_outs')
            .values({
              id: app.newId(),
              location_id: locationId,
              phone_e164: customer.phone_e164!,
              opted_out_at: now,
              source: 'manual',
              opted_out_by: req.auth!.realUserId ?? req.auth!.userId,
            })
            .onConflict((oc) =>
              oc.columns(['location_id', 'phone_e164']).where('opted_in_again_at', 'is', null).doNothing(),
            )
            .execute()
          await tx
            .updateTable('customers')
            .set((eb) => ({ sms_opted_out_at: now, version: eb('version', '+', 1), updated_at: now }))
            .where('id', '=', req.params.id)
            .execute()
        }
        if (optedIn !== undefined)
          await tx
            .updateTable('customers')
            .set((eb) => ({
              sms_opted_in: optedIn,
              sms_opt_in_source: optedIn ? 'dashboard' : null,
              sms_opt_in_at: optedIn ? now : null,
              version: eb('version', '+', 1),
              updated_at: now,
            }))
            .where('id', '=', req.params.id)
            .execute()

        const after = (await readConsent(tx, locationId, req.params.id))!
        await audit.record(tx, {
          locationId,
          action: 'customer.sms_consent',
          entityType: 'customer',
          entityId: req.params.id,
          before: { smsOptedIn: before.smsOptedIn, optedOut: before.optedOut },
          after: { smsOptedIn: after.smsOptedIn, optedOut: after.optedOut },
          ctx: auditContextOf(req),
        })
        return after
      }),
  )
}
