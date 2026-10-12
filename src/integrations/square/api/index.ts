import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { cardsApi } from './cards.js'
import { catalogApi } from './catalog.js'
import { checkoutApi } from './checkout.js'
import { customersApi } from './customers.js'
import { eventsApi } from './events.js'
import { invoicesApi } from './invoices.js'
import { locationsApi } from './locations.js'
import { ordersApi } from './orders.js'
import { paymentsApi } from './payments.js'
import { refundsApi } from './refunds.js'
import { subscriptionsApi } from './subscriptions.js'
import { webhooksApi } from './webhook-subscriptions.js'

/** The SquareApi port over one client (HTTP to Square or a simulator, or the in-process simulator's fetch). */
export function createSquareApi(c: SquareClient): SquareApi {
  return {
    locations: locationsApi(c),
    payments: paymentsApi(c),
    refunds: refundsApi(c),
    checkout: checkoutApi(c),
    orders: ordersApi(c),
    customers: customersApi(c),
    cards: cardsApi(c),
    catalog: catalogApi(c),
    subscriptions: subscriptionsApi(c),
    invoices: invoicesApi(c),
    events: eventsApi(c),
    webhooks: webhooksApi(c),
  }
}
