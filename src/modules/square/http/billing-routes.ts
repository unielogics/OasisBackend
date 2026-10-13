// Settings → Billing & integrations (ADR 0171, wave Q3 dashapi; api-spec section 30.13): one read for the whole panel and the writes
// that had no route yet. Every other part keeps its own route (reused, not copied):
//   GET  /settings/billing                              set.billing   the panel: Square status row, processor and switches (read-only,
//                                                                     from the environment), booking fee, link tipping, card fees,
//                                                                     renewal policy, price-change notice, consent text in use
//   PUT  /settings/billing/link-tipping                 set.billing   payments.link_tipping
//   PUT  /settings/billing/renewal-policy               set.billing   memberships.billing_policy
//   PUT  /settings/billing/price-change-notice          set.billing   memberships.price_change_notice_days
//   PUT  /settings/billing/sales-tax                    set.billing   tax.rate_dbp (ADR 0173: a percentage with up to 3 decimals)
//                                                                     and, when sent, tax.rounding (half_up default, half_even = Square's)
// The panel also carries the Square item library in short (squareItems, ADR 0172; the block: GET /integrations/square/items).
// Reused: GET /integrations/square + POST /integrations/square/test (status, Test connection), PUT /catalog/guest-fee (booking fee
// amount and collect mode, set.services), PUT /settings/card-fees (fees.card_on_file), POST /integrations/square/catalog/sync
// ("Sync to Square"). Each block carries its own version (body `version` or If-Match on its PUT: 428 without, 412 stale); a save is
// audited (`settings.update`) and publishes `settings.changed {key}` (platform/settings.ts updateSetting).
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { parseTaxPercent, TAX_ROUNDINGS, taxPercentLabel, type TaxRounding } from '../../../platform/money.js'
import { getSetting, updateSetting, type SettingKey } from '../../../platform/settings.js'
import { etag, inTx, requestContext, requiredVersion, storedUserId } from '../../settings/http/runtime.js'
import { loadItemsView } from '../../catalog/square/view.js'
import { rerateOpenInvoices } from '../../payments/tax-rate.js'
import { cardsOn } from '../charges.js'
import { CARD_PURPOSES, CONSENT_CHECKED_BY_DEFAULT, CURRENT_CONSENT_VERSION, consentText } from '../consents.js'
import { squareEnv } from '../runtime.js'
import { squareIntegrationView } from './routes.js'
import { SquareIntegrationView } from './schemas.js'

const TAGS = ['settings']
const Version = z.number().int().min(0)
/** Above this a sales tax rate needs `confirmHighRate` (15%; New Jersey's is 6.625%). */
export const SALES_TAX_PLAUSIBLE_MAX_DBP = 15_000

const Processing = z
  .object({
    processor: z.enum(['squarespace', 'square']).describe('PAYMENT_PROCESSOR: who takes new card money, links, saved cards, memberships and refunds'),
    squareProvider: z.enum(['sim', 'live']).describe('SQUARE_PROVIDER: sim answers in-process, nothing reaches Square'),
    squareEnvironment: z.enum(['sandbox', 'production']).describe('SQUARE_ENVIRONMENT'),
    writesEnabled: z.boolean().describe('SQUARE_WRITES_ENABLED: off = observe-only (mirror and match, nothing created at Square)'),
    membershipsEnabled: z.boolean().describe('SQUARE_MEMBERSHIPS_ENABLED: tier prices synced to Square and the join page takes a card'),
    itemsSyncEnabled: z.boolean().describe('SQUARE_ITEMS_SYNC_ENABLED: services and prices by size kept in step with Square’s item library (ADR 0172)'),
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
    .enum(TAX_ROUNDINGS)
    .describe(
      "tax.rounding: how new invoices round their tax, once on the subtotal: half_up (the default, the design's rule) or half_even (Square's rule, set at the rollout with 6.625%; ADR 0173). Each invoice keeps the rule it was made with",
    ),
  version: z.number().int().describe('The version of tax.rate_dbp: every save of this block writes the rate, so it covers the rounding too'),
})

/** The Sales tax block of Settings → Billing & integrations (ADR 0173). */
export function salesTaxView(rate: { value: number; version: number }, rounding: TaxRounding): z.infer<typeof SalesTax> {
  const label = taxPercentLabel(rate.value)
  return { percent: label.slice(0, -1), rateDbp: rate.value, label, rounding, version: rate.version }
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
  salesTax: SalesTax.describe('tax.rate_dbp and tax.rounding: PUT /settings/billing/sales-tax (applies to invoices made from then on)'),
  squareItems: z
    .object({
      mode: z.enum(['on', 'preview', 'off']),
      tax: z.object({ status: z.enum(['ok', 'create', 'blocked', 'error']), detail: z.string() }).nullable().describe('The last tax check'),
      counts: z.object({ onSquare: z.number().int(), waiting: z.number().int(), failed: z.number().int(), archived: z.number().int(), notSold: z.number().int() }),
      lastSyncAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .describe('The Square item library (ADR 0172) in short: GET /integrations/square/items has the whole block'),
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
      const [square, fee, tipping, fees, policy, notice, tax, rounding, items] = await Promise.all([
        squareIntegrationView(app, locationId),
        getSetting(app.db, locationId, 'booking.guest_fee'),
        getSetting(app.db, locationId, 'payments.link_tipping'),
        getSetting(app.db, locationId, 'fees.card_on_file'),
        getSetting(app.db, locationId, 'memberships.billing_policy'),
        getSetting(app.db, locationId, 'memberships.price_change_notice_days'),
        getSetting(app.db, locationId, 'tax.rate_dbp'),
        getSetting(app.db, locationId, 'tax.rounding'),
        loadItemsView(app.db, locationId, env),
      ])
      return {
        square,
        processing: {
          processor: env.PAYMENT_PROCESSOR,
          squareProvider: env.SQUARE_PROVIDER,
          squareEnvironment: env.SQUARE_ENVIRONMENT,
          writesEnabled: env.SQUARE_WRITES_ENABLED,
          membershipsEnabled: env.SQUARE_MEMBERSHIPS_ENABLED,
          itemsSyncEnabled: env.SQUARE_ITEMS_SYNC_ENABLED,
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
        salesTax: salesTaxView(tax, rounding.value),
        squareItems: {
          mode: items.mode,
          tax: items.taxCheck ? { status: items.taxCheck.status, detail: items.taxCheck.detail } : null,
          counts: items.counts,
          lastSyncAt: items.lastSyncAt,
        },
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
        summary: 'Save the sales tax rate (and, when sent, the rounding) of new invoices (ETag = version)',
        description:
          'tax.rate_dbp (ADR 0173; default 7%). `percent` is the rate as staff type it, with up to three decimals ("6.625" for New Jersey; a trailing % is accepted), 0 to 100; anything else is 422 `VALIDATION_FAILED` on `percent`. `rounding` (optional; tax.rounding, default `half_up`): `half_even` makes new invoices round their tax like Square (half to even, once on the subtotal), set at the rollout together with 6.625%; left out, the rounding stays as it is. Both apply to new invoices and, in the same transaction, to the open invoices of visits not done yet (not canceled, date not frozen at completion; audited `payments.tax_rerated` each, `invoice.updated`), so a visit booked before the change is charged the new rate; one that would end up overpaid (paid up front at the old rate) keeps its rate. A finished visit keeps the rate it was made with. A rate above 15% is refused (422 on `percent`) unless `confirmHighRate: true` is sent. `version` (or If-Match, the version of tax.rate_dbp) required: 428 without, 412 when stale; the rate and the rounding are saved together or not at all. Audited `settings.update`; publishes `settings.changed {key: "tax.rate_dbp"}` (and `{key: "tax.rounding"}` when the rounding changes).',
        body: z
          .object({
            percent: z.string().max(12),
            rounding: z.enum(TAX_ROUNDINGS).optional(),
            confirmHighRate: z.literal(true).optional(),
            version: Version.optional(),
          })
          .strict(),
        response: { 200: SalesTax },
      },
    },
    async (req, reply) => {
      const b = req.body as { percent: string; rounding?: TaxRounding; confirmHighRate?: true; version?: number }
      const dbp = parseTaxPercent(b.percent)
      if (dbp === null)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Enter the tax rate as a percentage, such as 6.625',
          errors: [{ path: 'percent', message: 'Use a percentage from 0 to 100 with up to three decimals, such as 6.625' }],
        })
      // a typo such as 66.25 would charge every new invoice (and Oasis's own Square tax) 66.25% (K4 review tax:H3)
      if (dbp > SALES_TAX_PLAUSIBLE_MAX_DBP && b.confirmHighRate !== true) {
        const message = `${taxPercentLabel(dbp)} is very high for a sales tax. Check the rate: New Jersey’s is 6.625%.`
        throw new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: 'percent', message }] })
      }
      const c = requestContext(req)
      const v = requiredVersion(req, b.version)
      const out = await inTx(app.db, async (tx) => {
        const updatedBy = await storedUserId(tx, c.userId)
        // the rate is always written (its version guards the whole block); the rounding only when it is sent and differs
        const rate = await updateSetting(tx, { locationId: c.locationId, key: 'tax.rate_dbp', value: dbp, expectedVersion: v, updatedBy, audit: c.audit })
        let rounding = (await getSetting(tx, c.locationId, 'tax.rounding')).value
        if (b.rounding !== undefined && b.rounding !== rounding)
          rounding = (await updateSetting(tx, { locationId: c.locationId, key: 'tax.rounding', value: b.rounding, updatedBy, audit: c.audit })).value
        // the visits booked before the change and not done yet take the new rate too (K4 review tax:M1)
        await rerateOpenInvoices(tx, { locationId: c.locationId, tax: { dbp: rate.value, rounding }, now: app.clock.now(), ctx: c.audit })
        return salesTaxView(rate, rounding)
      })
      etag(reply, out.version)
      return out
    },
  )
}
