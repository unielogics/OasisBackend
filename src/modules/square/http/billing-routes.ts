// Settings → Billing & integrations (ADR 0171, wave Q3 dashapi; api-spec section 30.13): one read for the whole panel and the writes
// that had no route yet. Every other part keeps its own route (reused, not copied):
//   GET  /settings/billing                              set.billing   the panel: Square status row, processor and switches (read-only,
//                                                                     from the environment), booking fee, link tipping, card fees,
//                                                                     renewal policy, price-change notice, consent text in use
//   PUT  /settings/billing/link-tipping                 set.billing   payments.link_tipping
//   PUT  /settings/billing/renewal-policy               set.billing   memberships.billing_policy
//   PUT  /settings/billing/price-change-notice          set.billing   memberships.price_change_notice_days
//   PUT  /settings/billing/sales-tax                    set.billing   tax.rate_dbp (ADR 0173: a percentage with up to 3 decimals)
// Reused: GET /integrations/square + POST /integrations/square/test (status, Test connection), PUT /catalog/guest-fee (booking fee
// amount and collect mode, set.services), PUT /settings/card-fees (fees.card_on_file), POST /integrations/square/catalog/sync
// ("Sync to Square"). Each block carries its own version (body `version` or If-Match on its PUT: 428 without, 412 stale); a save is
// audited (`settings.update`) and publishes `settings.changed {key}` (platform/settings.ts updateSetting).
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { NEW_INVOICE_TAX_ROUNDING, parseTaxPercent, taxPercentLabel } from '../../../platform/money.js'
import { getSetting, updateSetting, type SettingKey } from '../../../platform/settings.js'
import { etag, inTx, requestContext, requiredVersion, storedUserId } from '../../settings/http/runtime.js'
import { cardsOn } from '../charges.js'
import { CARD_PURPOSES, CONSENT_CHECKED_BY_DEFAULT, CURRENT_CONSENT_VERSION, consentText } from '../consents.js'
import { squareEnv } from '../runtime.js'
import { squareIntegrationView } from './routes.js'
import { SquareIntegrationView } from './schemas.js'

const TAGS = ['settings']
const Version = z.number().int().min(0)

const Processing = z
  .object({
    processor: z.enum(['squarespace', 'square']).describe('PAYMENT_PROCESSOR: who takes new card money, links, saved cards, memberships and refunds'),
    squareProvider: z.enum(['sim', 'live']).describe('SQUARE_PROVIDER: sim answers in-process, nothing reaches Square'),
    squareEnvironment: z.enum(['sandbox', 'production']).describe('SQUARE_ENVIRONMENT'),
    writesEnabled: z.boolean().describe('SQUARE_WRITES_ENABLED: off = observe-only (mirror and match, nothing created at Square)'),
    membershipsEnabled: z.boolean().describe('SQUARE_MEMBERSHIPS_ENABLED: tier prices synced to Square and the join page takes a card'),
    posAppSwitch: z.boolean().describe('SQUARE_POS_API_ENABLED: "Open Square POS" from the dashboard'),
    posAutomatch: z.enum(['evidence', 'amount']).describe('SQUARE_POS_AUTOMATCH: counter payments recorded on strong evidence only, or also on an amount alone'),
    publicLinksEnabled: z.boolean().describe('PUBLIC_LINKS_ENABLED: the personal pay, card and membership pages'),
    cardsOn: z.boolean().describe('Saved cards and fees work now (Square the processor)'),
  })
  .describe('Read only: these are switches of the server environment, changed at deploy time, never here')

const LinkTipping = z.object({ enabled: z.boolean().describe('Square’s checkout asks for a tip on payment links'), version: z.number().int() })
const RenewalPolicy = z.object({
  graceDays: z.number().int().describe('A failed renewal keeps the perks on this many days (the client is texted a card link at once)'),
  cancelDays: z.number().int().describe('Then past due (perks off) until this many days after the failure, when it is canceled at Square'),
  version: z.number().int(),
})
const PriceNotice = z.object({
  days: z.number().int().describe('"Move members": members on an older tier price are told this many days before their price moves'),
  version: z.number().int(),
})

const SalesTax = z.object({
  percent: z.string().describe('The rate new invoices are made with, as a percentage with up to three decimals: "7", "6.625"'),
  rateDbp: z.number().int().describe('The same rate in thousandths of a percent (tax.rate_dbp): 7000 = 7%, 6625 = 6.625%'),
  label: z.string().describe('How the tax line reads it: "7%", "6.625%"'),
  rounding: z
    .enum(['half_up', 'half_even'])
    .describe("How new invoices round their tax, once on the subtotal: half_even, Square's rule (ADR 0173; older invoices keep half_up)"),
  version: z.number().int(),
})

/** The Sales tax block of Settings → Billing & integrations (ADR 0173). */
export function salesTaxView(rec: { value: number; version: number }): z.infer<typeof SalesTax> {
  const label = taxPercentLabel(rec.value)
  return { percent: label.slice(0, -1), rateDbp: rec.value, label, rounding: NEW_INVOICE_TAX_ROUNDING, version: rec.version }
}

export const BillingSettingsView = z.object({
  square: SquareIntegrationView.describe('The same body as GET /integrations/square (Test connection: POST /integrations/square/test)'),
  processing: Processing,
  guestFee: z
    .object({ cents: z.number().int(), collect: z.enum(['counter', 'link', 'card_hold']), version: z.number().int() })
    .describe('booking.guest_fee: saved with PUT /catalog/guest-fee (set.services)'),
  linkTipping: LinkTipping.describe('payments.link_tipping: PUT /settings/billing/link-tipping'),
  cardFees: z
    .object({
      fees: z.object({ enabled: z.boolean(), noShowCents: z.number().int(), lateCancelCents: z.number().int() }),
      version: z.number().int(),
      active: z.boolean().describe('Fees are proposed now: enabled and Square the processor'),
    })
    .describe('fees.card_on_file: PUT /settings/card-fees'),
  renewalPolicy: RenewalPolicy.describe('memberships.billing_policy: PUT /settings/billing/renewal-policy'),
  priceChangeNotice: PriceNotice.describe('memberships.price_change_notice_days: PUT /settings/billing/price-change-notice'),
  salesTax: SalesTax.describe('tax.rate_dbp: PUT /settings/billing/sales-tax (applies to invoices made from then on)'),
  consent: z
    .object({
      version: z.string().describe('The card consent text version every new card is saved under'),
      checkedByDefault: z.boolean().describe('Always false: the client ticks the box'),
      purposes: z.array(z.enum(CARD_PURPOSES)),
      text: z.string().describe('The exact wording shown, with every purpose'),
    })
    .describe('Read only: a new wording is a new version, shipped with the code'),
})

export function registerBillingSettingsRoutes(app: AppInstance): void {
  const save = async <K extends SettingKey>(req: FastifyRequest, key: K, value: unknown, bodyVersion: number | undefined) => {
    const c = requestContext(req)
    const v = requiredVersion(req, bodyVersion)
    return inTx(app.db, async (tx) =>
      updateSetting(tx, {
        locationId: c.locationId,
        key,
        value: value as never,
        expectedVersion: v,
        updatedBy: await storedUserId(tx, c.userId),
        audit: c.audit,
      }),
    )
  }

  app.get(
    '/settings/billing',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        operationId: 'getBillingSettings',
        summary: 'Settings, Billing & integrations: everything the panel shows, in one read',
        description:
          'The Square status row (as GET /integrations/square), the processor and its switches (read only, from the server environment), the booking fee (saved with PUT /catalog/guest-fee), link tipping, the no-show and late-cancel fees on a saved card (PUT /settings/card-fees), the renewal policy of memberships billed by Square, the "Move members" notice, the sales tax rate of new invoices, and the card consent text in use. Each editable block carries its own `version`. Never contains a token or a key.',
        response: { 200: BillingSettingsView },
      },
    },
    async (req) => {
      const { locationId } = requestContext(req)
      const env = squareEnv()
      const [square, fee, tipping, fees, policy, notice, tax] = await Promise.all([
        squareIntegrationView(app, locationId),
        getSetting(app.db, locationId, 'booking.guest_fee'),
        getSetting(app.db, locationId, 'payments.link_tipping'),
        getSetting(app.db, locationId, 'fees.card_on_file'),
        getSetting(app.db, locationId, 'memberships.billing_policy'),
        getSetting(app.db, locationId, 'memberships.price_change_notice_days'),
        getSetting(app.db, locationId, 'tax.rate_dbp'),
      ])
      return {
        square,
        processing: {
          processor: env.PAYMENT_PROCESSOR,
          squareProvider: env.SQUARE_PROVIDER,
          squareEnvironment: env.SQUARE_ENVIRONMENT,
          writesEnabled: env.SQUARE_WRITES_ENABLED,
          membershipsEnabled: env.SQUARE_MEMBERSHIPS_ENABLED,
          posAppSwitch: env.SQUARE_POS_API_ENABLED,
          posAutomatch: env.SQUARE_POS_AUTOMATCH,
          publicLinksEnabled: app.env.PUBLIC_LINKS_ENABLED,
          cardsOn: cardsOn(env),
        },
        guestFee: { cents: fee.value.cents, collect: fee.value.collect, version: fee.version },
        linkTipping: { enabled: tipping.value, version: tipping.version },
        cardFees: { fees: fees.value, version: fees.version, active: fees.value.enabled && cardsOn(env) },
        renewalPolicy: { ...policy.value, version: policy.version },
        priceChangeNotice: { days: notice.value, version: notice.version },
        salesTax: salesTaxView(tax),
        consent: {
          version: CURRENT_CONSENT_VERSION,
          checkedByDefault: CONSENT_CHECKED_BY_DEFAULT,
          purposes: [...CARD_PURPOSES],
          text: consentText(CURRENT_CONSENT_VERSION, CARD_PURPOSES).text,
        },
      }
    },
  )

  app.put(
    '/settings/billing/link-tipping',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        operationId: 'putBillingLinkTipping',
        summary: 'Turn tipping on Square payment links on or off (ETag = version)',
        description:
          'payments.link_tipping (off by default, ADR 0171 D5): Square’s checkout asks for a tip on links made from now on; a tip is recorded as its own payment. `version` (or If-Match) required: 428 without, 412 when stale. Audited `settings.update`; publishes `settings.changed {key: "payments.link_tipping"}`.',
        body: z.object({ enabled: z.boolean(), version: Version.optional() }).strict(),
        response: { 200: LinkTipping },
      },
    },
    async (req, reply) => {
      const b = req.body as { enabled: boolean; version?: number }
      const r = await save(req, 'payments.link_tipping', b.enabled, b.version)
      etag(reply, r.version)
      return { enabled: r.value, version: r.version }
    },
  )

  app.put(
    '/settings/billing/renewal-policy',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        operationId: 'putBillingRenewalPolicy',
        summary: 'Save what happens when Square cannot charge a membership renewal (ETag = version)',
        description:
          'memberships.billing_policy (plan decision 7; default 7 and 21): the perks stay on for `graceDays` (0 to 60) after a failed renewal, then the membership is past due (perks off) until `cancelDays` (1 to 90, more than graceDays: 422 `VALIDATION_FAILED`), when it is canceled at Square. Any payment restores it. Applies to failures from now on and to the next daily run. `version` (or If-Match) required: 428 without, 412 when stale. Audited `settings.update`; publishes `settings.changed {key: "memberships.billing_policy"}`.',
        body: z
          .object({ graceDays: z.number().int().min(0).max(60), cancelDays: z.number().int().min(1).max(90), version: Version.optional() })
          .strict(),
        response: { 200: RenewalPolicy },
      },
    },
    async (req, reply) => {
      const { version, ...value } = req.body as { graceDays: number; cancelDays: number; version?: number }
      const r = await save(req, 'memberships.billing_policy', value, version)
      etag(reply, r.version)
      return { ...r.value, version: r.version }
    },
  )

  app.put(
    '/settings/billing/price-change-notice',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        operationId: 'putBillingPriceChangeNotice',
        summary: 'Save how many days members are told before "Move members" changes their price (ETag = version)',
        description:
          'memberships.price_change_notice_days (plan decision 8; default 30, 0 to 90). Members keep their price unless an admin presses "Move members" (POST /catalog/tiers/{key}/move-members), which texts this notice first. `version` (or If-Match) required: 428 without, 412 when stale. Audited `settings.update`; publishes `settings.changed {key: "memberships.price_change_notice_days"}`.',
        body: z.object({ days: z.number().int().min(0).max(90), version: Version.optional() }).strict(),
        response: { 200: PriceNotice },
      },
    },
    async (req, reply) => {
      const b = req.body as { days: number; version?: number }
      const r = await save(req, 'memberships.price_change_notice_days', b.days, b.version)
      etag(reply, r.version)
      return { days: r.value, version: r.version }
    },
  )
  app.put(
    '/settings/billing/sales-tax',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        operationId: 'putBillingSalesTax',
        summary: 'Save the sales tax rate of new invoices (ETag = version)',
        description:
          'tax.rate_dbp (ADR 0173; default 7%). `percent` is the rate as staff type it, with up to three decimals ("6.625" for New Jersey; a trailing % is accepted), 0 to 100; anything else is 422 `VALIDATION_FAILED` on `percent`. It applies to invoices made from now on: each invoice keeps the rate and the rounding it was made with, and every new invoice rounds its tax like Square (half to even, once on the subtotal). `version` (or If-Match) required: 428 without, 412 when stale. Audited `settings.update`; publishes `settings.changed {key: "tax.rate_dbp"}`.',
        body: z.object({ percent: z.string().max(12), version: Version.optional() }).strict(),
        response: { 200: SalesTax },
      },
    },
    async (req, reply) => {
      const b = req.body as { percent: string; version?: number }
      const dbp = parseTaxPercent(b.percent)
      if (dbp === null)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Enter the tax rate as a percentage, such as 6.625',
          errors: [{ path: 'percent', message: 'Use a percentage from 0 to 100 with up to three decimals, such as 6.625' }],
        })
      const r = await save(req, 'tax.rate_dbp', dbp, b.version)
      etag(reply, r.version)
      return salesTaxView(r)
    },
  )
}
