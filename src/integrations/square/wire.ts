// Square wire objects (API version 2026-09-16) as zod schemas. They declare what Oasis reads and let everything else pass through
// (`passthrough`): Square adds fields without a version bump. Required are only the fields a later step cannot work without (ids,
// states, money). The captured sandbox fixtures in test/fixtures/square/ are parsed through these in test/square/wire.test.ts.
import { z } from 'zod'

const str = z.string()
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish()

export const wireMoney = z.object({ amount: z.number().int(), currency: str }).passthrough()
export type WireMoney = z.infer<typeof wireMoney>

export const wireLocation = z
  .object({
    id: str,
    name: opt(str),
    merchant_id: opt(str),
    status: opt(str), // ACTIVE | INACTIVE
    currency: opt(str),
    country: opt(str),
    timezone: opt(str),
    capabilities: opt(z.array(str)), // CREDIT_CARD_PROCESSING, AUTOMATIC_TRANSFERS
    business_name: opt(str),
    type: opt(str),
  })
  .passthrough()
export type WireLocation = z.infer<typeof wireLocation>

const cardSummary = z
  .object({
    id: opt(str),
    card_brand: opt(str),
    last_4: opt(str),
    exp_month: opt(z.number()),
    exp_year: opt(z.number()),
    fingerprint: opt(str),
    card_type: opt(str),
    prepaid_type: opt(str),
    bin: opt(str),
  })
  .passthrough()

export const wirePayment = z
  .object({
    id: str,
    status: str, // APPROVED | PENDING | COMPLETED | CANCELED | FAILED
    created_at: str,
    updated_at: opt(str),
    amount_money: wireMoney,
    tip_money: opt(wireMoney),
    total_money: opt(wireMoney),
    approved_money: opt(wireMoney),
    refunded_money: opt(wireMoney),
    source_type: opt(str), // CARD | CASH | EXTERNAL | WALLET | BANK_ACCOUNT | BUY_NOW_PAY_LATER | SQUARE_ACCOUNT
    location_id: opt(str),
    order_id: opt(str),
    customer_id: opt(str),
    reference_id: opt(str),
    note: opt(str),
    receipt_number: opt(str),
    receipt_url: opt(str),
    buyer_email_address: opt(str),
    application_details: opt(z.object({ square_product: opt(str), application_id: opt(str) }).passthrough()),
    card_details: opt(
      z
        .object({
          status: opt(str),
          card: opt(cardSummary),
          entry_method: opt(str), // KEYED | SWIPED | EMV | ON_FILE | CONTACTLESS
          cvv_status: opt(str),
          avs_status: opt(str),
          wallet_details: opt(z.object({}).passthrough()),
        })
        .passthrough(),
    ),
    wallet_details: opt(z.object({ status: opt(str), brand: opt(str) }).passthrough()),
    cash_details: opt(z.object({}).passthrough()),
    refund_ids: opt(z.array(str)),
    version_token: opt(str),
  })
  .passthrough()
export type WirePayment = z.infer<typeof wirePayment>

export const wireRefund = z
  .object({
    id: str,
    status: str, // PENDING | COMPLETED | REJECTED | FAILED
    payment_id: opt(str),
    order_id: opt(str),
    location_id: opt(str),
    amount_money: wireMoney,
    reason: opt(str),
    created_at: opt(str),
    updated_at: opt(str),
  })
  .passthrough()
export type WireRefund = z.infer<typeof wireRefund>

export const wirePaymentLink = z
  .object({
    id: str,
    version: z.number().int(),
    order_id: opt(str),
    url: str,
    long_url: opt(str),
    created_at: opt(str),
    updated_at: opt(str),
    payment_note: opt(str),
    checkout_options: opt(z.object({}).passthrough()),
  })
  .passthrough()
export type WirePaymentLink = z.infer<typeof wirePaymentLink>

export const wireOrder = z
  .object({
    id: str,
    location_id: str,
    state: opt(str), // OPEN | COMPLETED | CANCELED | DRAFT
    reference_id: opt(str),
    customer_id: opt(str),
    version: opt(z.number().int()),
    line_items: opt(
      z.array(
        z
          .object({
            uid: opt(str),
            name: opt(str),
            quantity: str,
            base_price_money: opt(wireMoney),
            total_money: opt(wireMoney),
            // a line rung up from the item library (ADR 0172): the variation, its version and name; the tax Square put on it
            catalog_object_id: opt(str),
            catalog_version: opt(z.number().int()),
            variation_name: opt(str),
            item_type: opt(str),
            total_tax_money: opt(wireMoney),
            total_discount_money: opt(wireMoney),
            applied_taxes: opt(z.array(z.object({ uid: opt(str), tax_uid: opt(str), applied_money: opt(wireMoney) }).passthrough())),
          })
          .passthrough(),
      ),
    ),
    taxes: opt(
      z.array(
        z
          .object({ uid: opt(str), catalog_object_id: opt(str), name: opt(str), percentage: opt(str), type: opt(str), scope: opt(str), applied_money: opt(wireMoney) })
          .passthrough(),
      ),
    ),
    total_money: opt(wireMoney),
    total_tax_money: opt(wireMoney),
    total_tip_money: opt(wireMoney),
    total_discount_money: opt(wireMoney),
    net_amount_due_money: opt(wireMoney),
    tenders: opt(z.array(z.object({ id: opt(str), type: opt(str), payment_id: opt(str), amount_money: opt(wireMoney) }).passthrough())),
    created_at: opt(str),
    updated_at: opt(str),
  })
  .passthrough()
export type WireOrder = z.infer<typeof wireOrder>

/** A CalculateOrder answer: the order as Square would price it; nothing is created, so it may come without an id. */
export const wireCalculatedOrder = wireOrder.extend({ id: opt(str), location_id: opt(str) })
export type WireCalculatedOrder = z.infer<typeof wireCalculatedOrder>

export const wireCustomer = z
  .object({
    id: str,
    given_name: opt(str),
    family_name: opt(str),
    email_address: opt(str),
    phone_number: opt(str),
    reference_id: opt(str),
    created_at: opt(str),
    updated_at: opt(str),
    version: opt(z.number().int()),
  })
  .passthrough()
export type WireCustomer = z.infer<typeof wireCustomer>

export const wireCard = z
  .object({
    id: str,
    card_brand: opt(str),
    last_4: opt(str),
    exp_month: opt(z.number()),
    exp_year: opt(z.number()),
    cardholder_name: opt(str),
    customer_id: opt(str),
    reference_id: opt(str),
    enabled: z.boolean(),
    card_type: opt(str),
    prepaid_type: opt(str),
    fingerprint: opt(str),
    merchant_id: opt(str),
    billing_address: opt(z.object({ postal_code: opt(str) }).passthrough()),
    version: opt(z.number().int()),
  })
  .passthrough()
export type WireCard = z.infer<typeof wireCard>

const pricing = z.object({ type: opt(str), price_money: opt(wireMoney) }).passthrough()
const phase = z.object({ uid: opt(str), cadence: str, ordinal: opt(z.number().int()), periods: opt(z.number().int()), pricing: opt(pricing) }).passthrough()

/** CatalogItemVariation data (ADR 0172): what the item library sync reads and owns; everything else passes through. */
export const wireItemVariationData = z
  .object({
    item_id: opt(str),
    name: opt(str),
    ordinal: opt(z.number().int()),
    pricing_type: opt(str), // FIXED_PRICING | VARIABLE_PRICING
    price_money: opt(wireMoney),
    user_data: opt(str),
    sellable: opt(z.boolean()),
    location_overrides: opt(
      z.array(z.object({ location_id: opt(str), pricing_type: opt(str), price_money: opt(wireMoney) }).passthrough()),
    ),
  })
  .passthrough()

/** Where a catalog object is present (Square: everywhere unless present_at_all_locations is false; a list of ids otherwise). */
const presence = {
  present_at_all_locations: opt(z.boolean()),
  present_at_location_ids: opt(z.array(str)),
  absent_at_location_ids: opt(z.array(str)),
}

/** A variation nested in an item (Square answers an item with its variations inside item_data.variations). */
export const wireNestedVariation = z
  .object({
    type: str,
    id: str,
    version: opt(z.number().int()),
    is_deleted: opt(z.boolean()),
    ...presence,
    item_variation_data: opt(wireItemVariationData),
  })
  .passthrough()

const categoryRef = z.object({ id: str, ordinal: opt(z.number()) }).passthrough()

export const wireItemData = z
  .object({
    name: opt(str),
    buyer_facing_name: opt(str),
    product_type: opt(str), // REGULAR | APPOINTMENTS_SERVICE | ...
    is_taxable: opt(z.boolean()),
    is_archived: opt(z.boolean()),
    tax_ids: opt(z.array(str)),
    categories: opt(z.array(categoryRef)),
    reporting_category: opt(categoryRef),
    variations: opt(z.array(wireNestedVariation)),
  })
  .passthrough()

export const wireCategoryData = z.object({ name: opt(str) }).passthrough()

export const wireTaxData = z
  .object({
    name: opt(str),
    calculation_phase: opt(str), // TAX_SUBTOTAL_PHASE | TAX_TOTAL_PHASE
    inclusion_type: opt(str), // ADDITIVE | INCLUSIVE
    percentage: opt(str), // a decimal string: "6.625"
    applies_to_custom_amounts: opt(z.boolean()),
    enabled: opt(z.boolean()),
  })
  .passthrough()

export const wireCatalogObject = z
  .object({
    type: str, // SUBSCRIPTION_PLAN | SUBSCRIPTION_PLAN_VARIATION | ITEM | ITEM_VARIATION | CATEGORY | TAX | ...
    id: str,
    version: opt(z.number().int()),
    is_deleted: opt(z.boolean()),
    updated_at: opt(str),
    ...presence,
    item_data: opt(wireItemData),
    item_variation_data: opt(wireItemVariationData),
    category_data: opt(wireCategoryData),
    tax_data: opt(wireTaxData),
    subscription_plan_data: opt(
      z.object({ name: opt(str), subscription_plan_variations: opt(z.array(z.object({}).passthrough())) }).passthrough(),
    ),
    subscription_plan_variation_data: opt(
      z.object({ name: opt(str), subscription_plan_id: opt(str), phases: opt(z.array(phase)) }).passthrough(),
    ),
  })
  .passthrough()
export type WireCatalogObject = z.infer<typeof wireCatalogObject>
export type WireItemData = z.infer<typeof wireItemData>
export type WireNestedVariation = z.infer<typeof wireNestedVariation>
export type WireItemVariationData = z.infer<typeof wireItemVariationData>
export type WireTaxData = z.infer<typeof wireTaxData>

export const wireSubscriptionAction = z
  .object({ id: str, type: str, effective_date: opt(str), new_plan_variation_id: opt(str) })
  .passthrough()
export type WireSubscriptionAction = z.infer<typeof wireSubscriptionAction>

export const wireSubscription = z
  .object({
    id: str,
    location_id: opt(str),
    plan_variation_id: opt(str),
    customer_id: opt(str),
    card_id: opt(str),
    status: str, // PENDING | ACTIVE | CANCELED | DEACTIVATED | PAUSED
    start_date: opt(str),
    canceled_date: opt(str),
    charged_through_date: opt(str),
    paid_until_date: opt(str),
    invoice_ids: opt(z.array(str)),
    price_override_money: opt(wireMoney),
    version: opt(z.number().int()),
    created_at: opt(str),
    timezone: opt(str),
    actions: opt(z.array(wireSubscriptionAction)),
  })
  .passthrough()
export type WireSubscription = z.infer<typeof wireSubscription>

export const wireInvoice = z
  .object({
    id: str,
    version: opt(z.number().int()),
    location_id: opt(str),
    order_id: opt(str),
    status: str, // DRAFT | UNPAID | SCHEDULED | PARTIALLY_PAID | PAID | PARTIALLY_REFUNDED | REFUNDED | CANCELED | FAILED | PAYMENT_PENDING
    subscription_id: opt(str),
    invoice_number: opt(str),
    public_url: opt(str),
    payment_requests: opt(
      z.array(
        z
          .object({
            uid: opt(str),
            request_type: opt(str),
            due_date: opt(str),
            computed_amount_money: opt(wireMoney),
            total_completed_amount_money: opt(wireMoney),
            automatic_payment_source: opt(str),
            card_id: opt(str),
          })
          .passthrough(),
      ),
    ),
    primary_recipient: opt(z.object({ customer_id: opt(str) }).passthrough()),
    created_at: opt(str),
    updated_at: opt(str),
  })
  .passthrough()
export type WireInvoice = z.infer<typeof wireInvoice>

/** The envelope of a webhook delivery and of a SearchEvents result (the same shape). */
export const wireEvent = z
  .object({
    merchant_id: opt(str),
    location_id: opt(str),
    type: str,
    event_id: str,
    created_at: str,
    // catalog.version.updated and a few others carry no id
    data: z.object({ type: str, id: opt(str), deleted: opt(z.boolean()), object: opt(z.record(z.unknown())) }).passthrough(),
  })
  .passthrough()
export type WireEvent = z.infer<typeof wireEvent>

export const wireWebhookSubscription = z
  .object({
    id: str,
    name: opt(str),
    enabled: opt(z.boolean()),
    event_types: opt(z.array(str)),
    notification_url: opt(str),
    api_version: opt(str),
    signature_key: opt(str),
    created_at: opt(str),
    updated_at: opt(str),
  })
  .passthrough()
export type WireWebhookSubscription = z.infer<typeof wireWebhookSubscription>

const page = { cursor: opt(str) }

/** Response envelopes, by call. */
export const wire = {
  locations: z.object({ locations: z.array(wireLocation).default([]) }).passthrough(),
  location: z.object({ location: wireLocation }).passthrough(),
  payment: z.object({ payment: wirePayment }).passthrough(),
  payments: z.object({ payments: z.array(wirePayment).default([]), ...page }).passthrough(),
  refund: z.object({ refund: wireRefund }).passthrough(),
  refunds: z.object({ refunds: z.array(wireRefund).default([]), ...page }).passthrough(),
  paymentLink: z
    .object({
      payment_link: wirePaymentLink,
      related_resources: opt(z.object({ orders: opt(z.array(wireOrder)) }).passthrough()),
    })
    .passthrough(),
  paymentLinks: z.object({ payment_links: z.array(wirePaymentLink).default([]), ...page }).passthrough(),
  deletedPaymentLink: z.object({ id: opt(str), cancelled_order_id: opt(str) }).passthrough(),
  order: z.object({ order: wireOrder }).passthrough(),
  orderCalculated: z.object({ order: wireCalculatedOrder }).passthrough(),
  orders: z.object({ orders: z.array(wireOrder).default([]) }).passthrough(),
  customer: z.object({ customer: wireCustomer }).passthrough(),
  customers: z.object({ customers: z.array(wireCustomer).default([]), ...page }).passthrough(),
  card: z.object({ card: wireCard }).passthrough(),
  cards: z.object({ cards: z.array(wireCard).default([]), ...page }).passthrough(),
  catalogObject: z
    .object({
      catalog_object: wireCatalogObject,
      id_mappings: opt(z.array(z.object({ client_object_id: opt(str), object_id: opt(str) }).passthrough())),
    })
    .passthrough(),
  catalogBatch: z
    .object({
      objects: z.array(wireCatalogObject).default([]),
      id_mappings: opt(z.array(z.object({ client_object_id: opt(str), object_id: opt(str) }).passthrough())),
    })
    .passthrough(),
  catalogRetrieve: z.object({ object: wireCatalogObject, related_objects: opt(z.array(wireCatalogObject)) }).passthrough(),
  catalogBatchRetrieve: z
    .object({ objects: z.array(wireCatalogObject).default([]), related_objects: opt(z.array(wireCatalogObject)) })
    .passthrough(),
  catalogSearch: z
    .object({ objects: z.array(wireCatalogObject).default([]), related_objects: opt(z.array(wireCatalogObject)), ...page })
    .passthrough(),
  catalogDelete: z.object({ deleted_object_ids: z.array(str).default([]) }).passthrough(),
  subscription: z
    .object({ subscription: wireSubscription, actions: opt(z.array(wireSubscriptionAction)) })
    .passthrough(),
  subscriptions: z.object({ subscriptions: z.array(wireSubscription).default([]), ...page }).passthrough(),
  bulkSwap: z.object({ affected_subscriptions: opt(z.number().int()) }).passthrough(),
  invoice: z.object({ invoice: wireInvoice }).passthrough(),
  invoices: z.object({ invoices: z.array(wireInvoice).default([]), ...page }).passthrough(),
  events: z
    .object({
      events: z.array(wireEvent).default([]),
      metadata: opt(z.array(z.object({ event_id: opt(str), api_version: opt(str) }).passthrough())),
      ...page,
    })
    .passthrough(),
  eventTypes: z
    .object({
      event_types: z.array(str).default([]),
      metadata: opt(z.array(z.object({ event_type: opt(str), api_version_introduced: opt(str) }).passthrough())),
    })
    .passthrough(),
  empty: z.object({}).passthrough(),
  webhookSubscription: z.object({ subscription: wireWebhookSubscription }).passthrough(),
  webhookSubscriptions: z.object({ subscriptions: z.array(wireWebhookSubscription).default([]), ...page }).passthrough(),
  webhookTest: z
    .object({
      subscription_test_result: z
        .object({ id: opt(str), status_code: opt(z.number().int()), payload: opt(str), created_at: opt(str) })
        .passthrough(),
    })
    .passthrough(),
  signatureKey: z.object({ signature_key: str }).passthrough(),
} as const
