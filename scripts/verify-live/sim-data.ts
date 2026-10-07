// A small, deterministic Squarespace shop for `pnpm verify:squarespace --sim`: two membership products (one with a renewal
// history), services, a partial refund, payment-plan and pending orders (to exercise paging with the rare payment states),
// a test-mode order and a physical product.
import type { Clock } from '../../src/platform/clock.js'
import type { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'

const DAY = 86_400_000

export function seedSquarespaceSim(store: SquarespaceSimStore, clock: Clock): void {
  const now = clock.now().getTime()
  const at = (daysAgo: number): Date => new Date(now - daysAgo * DAY)
  const premium = {
    productId: 'sim-prod-premium',
    sku: 'MEM-PREMIUM',
    name: 'Premium Care Membership',
    unitCents: 14900,
    lineItemType: 'SERVICE',
  }
  const first = store.createOrder({
    email: 'maria.alvarez@example.com',
    name: 'Maria Alvarez',
    phone: '5557120188',
    lineItems: [premium],
    taxCents: 1043,
    createdOn: at(66),
    pay: { brand: 'VISA', paidOn: at(66) },
  })
  const second = store.renewSubscription(first.orderId, { createdOn: at(36) })
  store.renewSubscription(second.orderId, { createdOn: at(6) })
  const sam = store.createOrder({
    email: 'sam.okafor@example.com',
    name: 'Sam Okafor',
    phone: '(555) 340-7781',
    lineItems: [premium],
    taxCents: 1043,
    createdOn: at(40),
    pay: { brand: 'AMEX', paidOn: at(40) },
  })
  store.renewSubscription(sam.orderId, { createdOn: at(10) })
  store.createOrder({
    email: 'dana.price@example.com',
    name: 'Dana Price',
    phone: '5553019920',
    lineItems: [
      {
        productId: 'sim-prod-exec',
        sku: 'MEM-EXECUTIVE',
        name: 'Executive Care Membership',
        unitCents: 24900,
        lineItemType: 'SERVICE',
      },
    ],
    taxCents: 1743,
    createdOn: at(12),
    pay: { brand: 'MASTERCARD', paidOn: at(12) },
  })
  store.createOrder({
    email: 'liam.chen@example.com',
    name: 'Liam Chen',
    phone: '(555) 301-4420',
    lineItems: [
      { productId: 'sim-prod-detail', sku: 'DET-SEDAN', name: 'Full Detail - Sedan', unitCents: 18900 },
    ],
    taxCents: 1323,
    createdOn: at(1),
    pay: { brand: 'MASTERCARD' },
  })
  const wash = store.createOrder({
    email: 'aisha.rahman@example.com',
    name: 'Aisha Rahman',
    phone: '555-208-1177',
    lineItems: [{ productId: 'sim-prod-wash', sku: 'WASH-EXEC', name: 'Executive Wash', unitCents: 5900 }],
    taxCents: 413,
    createdOn: at(4),
  })
  store.refund(wash.orderId, { amountCents: 2000, refundedOn: at(3) })
  for (const [i, state] of (['PENDING', 'PARTIALLY_PAID', 'PENDING', 'FAILED'] as const).entries()) {
    const o = store.createOrder({
      email: `plan${i}@example.com`,
      name: `Plan Customer${i}`,
      phone: `555300${1000 + i}`,
      lineItems: [
        { productId: 'sim-prod-detail', sku: 'DET-SEDAN', name: 'Full Detail - Sedan', unitCents: 18900 },
      ],
      taxCents: 1323,
      createdOn: at(2 + i),
      pay: false,
    })
    store.setState(o.orderId, { paymentState: state })
  }
  store.createOrder({
    email: 'qa.tester@example.com',
    name: 'QA Tester',
    lineItems: [{ sku: 'WASH-EXEC', name: 'Executive Wash', unitCents: 5900 }],
    testMode: true,
    createdOn: at(1),
  })
  store.createOrder({
    email: 'gift.buyer@example.com',
    name: 'Gift Buyer',
    lineItems: [
      {
        productId: 'sim-prod-shirt',
        sku: 'TSHIRT-M',
        name: 'Oasis T-Shirt (M)',
        unitCents: 2800,
        lineItemType: 'PHYSICAL_PRODUCT',
      },
    ],
    createdOn: at(5),
  })
  store.createOrder({
    name: 'Counter Sale',
    lineItems: [{ productId: 'sim-prod-wash', sku: 'WASH-EXEC', name: 'Executive Wash', unitCents: 5900 }],
    taxCents: 413,
    createdOn: at(7),
    channel: 'pos',
  })
}
