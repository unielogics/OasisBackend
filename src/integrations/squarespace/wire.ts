import { z } from 'zod'

/**
 * Lenient schemas for the documented wire shapes. Squarespace may add fields without a version change and
 * array fields may be null or [], so everything is optional/nullish and unknown keys pass through.
 * Source: https://developers.squarespace.com/commerce-apis (orders, transactions, contacts), fetched 2026-10-06.
 */
export const wireMoney = z
  .object({ currency: z.string().nullish(), value: z.union([z.number(), z.string()]) })
  .passthrough()
export type WireMoney = z.infer<typeof wireMoney>

const wireAddress = z
  .object({
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .passthrough()

export const wireLineItem = z
  .object({
    id: z.string().nullish(),
    productId: z.string().nullish(),
    productName: z.string().nullish(),
    sku: z.string().nullish(),
    variantId: z.string().nullish(),
    quantity: z.number().nullish(),
    unitPricePaid: wireMoney.nullish(),
    lineItemType: z.string().nullish(),
  })
  .passthrough()

export const wireOrder = z
  .object({
    id: z.string(),
    orderNumber: z.union([z.string(), z.number()]),
    createdOn: z.string(),
    modifiedOn: z.string(),
    channel: z.string().nullish(),
    channelName: z.string().nullish(),
    testmode: z.boolean().nullish(),
    customerEmail: z.string().nullish(),
    customerId: z.string().nullish(),
    paymentState: z.string().nullish(),
    fulfillmentStatus: z.string().nullish(),
    billingAddress: wireAddress.nullish(),
    shippingAddress: wireAddress.nullish(),
    lineItems: z.array(wireLineItem).nullish(),
    subtotal: wireMoney.nullish(),
    shippingTotal: wireMoney.nullish(),
    discountTotal: wireMoney.nullish(),
    taxTotal: wireMoney.nullish(),
    refundedTotal: wireMoney.nullish(),
    grandTotal: wireMoney,
    priceTaxInterpretation: z.string().nullish(),
    externalOrderReference: z.string().nullish(),
  })
  .passthrough()
export type WireOrder = z.infer<typeof wireOrder>

const wireRefund = z
  .object({
    id: z.string(),
    amount: wireMoney,
    refundedOn: z.string().nullish(),
    externalTransactionId: z.string().nullish(),
  })
  .passthrough()

const wirePayment = z
  .object({
    id: z.string(),
    amount: wireMoney,
    creditCardType: z.string().nullish(),
    externalTransactionId: z.string().nullish(),
    giftCardId: z.string().nullish(),
    paidOn: z.string().nullish(),
    provider: z.string().nullish(),
    refundedAmount: wireMoney.nullish(),
    refunds: z.array(wireRefund).nullish(),
  })
  .passthrough()

export const wireTransactionDocument = z
  .object({
    id: z.string(),
    createdOn: z.string(),
    modifiedOn: z.string(),
    customerEmail: z.string().nullish(),
    salesOrderId: z.string().nullish(),
    voided: z.boolean().nullish(),
    provider: z.string().nullish(),
    payments: z.array(wirePayment).nullish(),
    refunds: z.array(wireRefund).nullish(),
    paymentGatewayError: z.string().nullish(),
  })
  .passthrough()
export type WireTransactionDocument = z.infer<typeof wireTransactionDocument>

export const wireContact = z
  .object({
    id: z.string(),
    createdOn: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    primaryEmail: z.object({ email: z.string().nullish() }).passthrough().nullish(),
    defaultShippingAddress: z
      .object({ address: z.object({ phoneNumber: z.string().nullish() }).passthrough().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough()
export type WireContact = z.infer<typeof wireContact>

export const wirePagination = z
  .object({
    hasNextPage: z.boolean().nullish(),
    nextPageCursor: z.string().nullish(),
    nextPageUrl: z.string().nullish(),
  })
  .passthrough()
export type WirePagination = z.infer<typeof wirePagination>

export const wireOrderList = z.object({
  pagination: wirePagination.nullish(),
  result: z.array(z.unknown()).nullish(),
})
export const wireTransactionList = z.object({
  pagination: wirePagination.nullish(),
  documents: z.array(z.unknown()).nullish(),
})
export const wireContactList = z.object({
  pagination: wirePagination.nullish(),
  contacts: z.array(z.unknown()).nullish(),
})

/** Webhook notification envelope (webhooks/overview). `data` differs per topic. */
export const wireNotification = z
  .object({
    id: z.string(),
    websiteId: z.string().nullish(),
    subscriptionId: z.string().nullish(),
    topic: z.string(),
    createdOn: z.string(),
    data: z.record(z.unknown()).nullish(),
  })
  .passthrough()
export type WireNotification = z.infer<typeof wireNotification>

export const PAYMENT_STATES = [
  'NOT_CHARGED',
  'AUTHORIZED',
  'PAID',
  'PARTIALLY_PAID',
  'PENDING',
  'FAILED',
  'REFUND_PENDING',
  'REFUNDED',
  'REFUND_FAILED',
] as const
