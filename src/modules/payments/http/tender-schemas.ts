// Zod schemas shared by the payments and the Operations DTOs (ADR 0171, wave Q3 dashapi): the processing block (processor and the
// usable Square tenders) and the deposit block. Only zod here, so the scheduling schemas can import it without the payments module.
import { z } from '../../../http/zod.js'

/** Who takes card money and which Square tenders staff may offer (ADR 0171; wave Q3 dashapi): the same for every role. */
export const InvoiceProcessing = z
  .object({
    processor: z.enum(['squarespace', 'square']).describe('PAYMENT_PROCESSOR: who takes new card money, links and refunds'),
    squarePosAppSwitch: z.boolean().describe('SQUARE_POS_API_ENABLED: "Open Square POS" (POST /invoices/{id}/square-pos-intents)'),
    squareTenders: z
      .object({
        reader: z.boolean().describe('"Square reader": Square is the processor (the entry waits for the counter matcher; works observe-only)'),
        link: z.boolean().describe('"Payment link" by Square: Square is the processor and Square writes are on'),
        savedCard: z
          .object({
            cardId: z.string(),
            label: z.string().describe('"Visa ••4242"'),
            brand: z.string().nullable(),
            last4: z.string().nullable(),
          })
          .nullable()
          .describe(
            '"Saved card": the card POST /invoices/{id}/card-charges would charge (the newest active, unexpired card whose live consent covers balances); null when there is none, the invoice is canceled, Square is not the processor or writes are off',
          ),
      })
      .describe('The Square tenders the Collect sheet may offer; all off before the cutover (PAYMENT_PROCESSOR=squarespace)'),
  })

/** The deposit of a visit (ADR 0171 D2; wave Q3 dashapi, dashboard review Q2c N1). */
export const DepositView = z
  .object({
    state: z
      .enum(['requested', 'link_sent', 'link_expired', 'paid', 'kept', 'refunded', 'refund_pending'])
      .describe(
        'requested: a deposit link is asked for (being made, or made and not texted); link_sent: texted, not paid; link_expired: the link lapsed or was withdrawn unpaid; paid: a deposit paid on an open visit (a partial refund shows in refundedCents; a deposit paid by link and then voided gives null); on an open visit also refund_pending (a refund waiting for approval would leave the invoice holding less than the deposit) and refunded (the invoice holds nothing any more); for a canceled visit holding money: refund_pending (a refund waits for approval), refunded (all of it given back), kept (some or all of it stays)',
      ),
    requestedCents: z.number().int().nullable().describe('What the newest deposit link asks for; null without one'),
    paidCents: z.number().int().describe('Open visit: deposit payments less voided ones. Canceled visit: the money paid (refunds not subtracted)'),
    refundedCents: z.number().int().describe('Refunds done (a failed card refund is not counted)'),
    pendingRefundCents: z.number().int().describe('Refunds waiting for approval'),
    keptCents: z.number().int().describe('Canceled visit: paid less refunded less pending refunds; 0 on an open visit'),
    refundFailed: z.boolean().describe('A card refund the processor reported failed: that money was not given back'),
    refundSending: z.boolean().describe('A card refund sent to the processor and not confirmed yet (it already counts as refunded)'),
    link: z
      .object({
        state: z.enum(['pending', 'active', 'paid', 'expired', 'canceled']),
        sentAt: z.string().nullable(),
        expiresAt: z.string().nullable(),
        createdAt: z.string(),
      })
      .nullable()
      .describe('The newest deposit link (never its URL)'),
  })
