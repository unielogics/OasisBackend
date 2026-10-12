// The Square API as Oasis uses it (ADR 0171). The modules depend on this port only; squareApiFor(env) gives the HTTP client
// (Square, or a `pnpm sim:square` simulator through SQUARE_API_BASE) or the in-process simulator. Requests and answers are Square's
// own snake_case wire shapes (src/integrations/square/wire.ts); amounts are integer cents in Money objects (USD only, money.ts).
// Every call that creates something takes a SquareKey (keys.ts), so it cannot be sent without a deterministic idempotency key.
import type { SquareKey } from '../square/keys.js'
import type {
  WireCard,
  WireCatalogObject,
  WireCustomer,
  WireEvent,
  WireInvoice,
  WireLocation,
  WireOrder,
  WirePayment,
  WirePaymentLink,
  WireRefund,
  WireSubscription,
  WireSubscriptionAction,
  WireWebhookSubscription,
} from '../square/wire.js'

/** A Money object we send (USD integer cents: build it with usd() in square/money.ts). */
export interface Money {
  amount: number
  currency: string
}

export interface Paged<T> {
  items: T[]
  cursor?: string
}

type Extra = Record<string, unknown>

export interface CreatePaymentInput extends Extra {
  source_id: string
  amount_money: Money
  location_id: string
  customer_id?: string
  order_id?: string
  reference_id?: string
  note?: string
  autocomplete?: boolean
  tip_money?: Money
  verification_token?: string
}

export interface ListQuery {
  begin_time?: string
  end_time?: string
  sort_order?: 'ASC' | 'DESC'
  cursor?: string
  location_id?: string
  limit?: number
}

export interface RefundInput extends Extra {
  payment_id: string
  amount_money: Money
  reason?: string
}

export interface PaymentLinkInput extends Extra {
  quick_pay?: { name: string; price_money: Money; location_id: string }
  order?: Extra & { location_id: string }
  checkout_options?: Extra
  pre_populated_data?: Extra
  payment_note?: string
  description?: string
}

export interface CustomerInput extends Extra {
  given_name?: string
  family_name?: string
  email_address?: string
  phone_number?: string
  reference_id?: string
  note?: string
}

export interface CardInput {
  source_id: string
  verification_token?: string
  card: Extra & { customer_id: string; reference_id?: string; cardholder_name?: string; billing_address?: { postal_code?: string } }
}

export interface CreateSubscriptionInput extends Extra {
  location_id: string
  plan_variation_id: string
  customer_id: string
  card_id?: string
  start_date?: string
  timezone?: string
}

export interface EventSearchQuery {
  cursor?: string
  limit?: number
  event_types?: string[]
  location_ids?: string[]
  merchant_ids?: string[]
  start_at?: string
  end_at?: string
}

export interface WebhookSubscriptionInput extends Extra {
  name?: string
  event_types: string[]
  notification_url: string
  api_version?: string
  enabled?: boolean
}

export interface SquareApi {
  locations: {
    list(): Promise<WireLocation[]>
    retrieve(id: string): Promise<WireLocation>
  }
  payments: {
    create(key: SquareKey, input: CreatePaymentInput): Promise<WirePayment>
    get(id: string): Promise<WirePayment>
    list(q?: ListQuery): Promise<Paged<WirePayment>>
    cancel(id: string): Promise<WirePayment | null>
  }
  refunds: {
    refund(key: SquareKey, input: RefundInput): Promise<WireRefund>
    get(id: string): Promise<WireRefund>
    list(q?: ListQuery): Promise<Paged<WireRefund>>
  }
  checkout: {
    createLink(key: SquareKey, input: PaymentLinkInput): Promise<{ link: WirePaymentLink; order?: WireOrder }>
    retrieveLink(id: string): Promise<WirePaymentLink>
    listLinks(q?: { cursor?: string; limit?: number }): Promise<Paged<WirePaymentLink>>
    updateLink(id: string, link: Extra & { version: number }): Promise<WirePaymentLink>
    /** 404 counts as done: resolves to false when there was nothing left to delete. */
    deleteLink(id: string): Promise<boolean>
  }
  orders: {
    retrieve(id: string): Promise<WireOrder>
    batchRetrieve(locationId: string, ids: string[]): Promise<WireOrder[]>
  }
  customers: {
    search(q: { reference_id?: string; email_address?: string; phone_number?: string; cursor?: string; limit?: number }): Promise<Paged<WireCustomer>>
    create(key: SquareKey, input: CustomerInput): Promise<WireCustomer>
    update(id: string, input: CustomerInput & { version?: number }): Promise<WireCustomer>
    retrieve(id: string): Promise<WireCustomer>
    /** 404 counts as done. */
    delete(id: string): Promise<boolean>
  }
  cards: {
    create(key: SquareKey, input: CardInput): Promise<WireCard>
    retrieve(id: string): Promise<WireCard>
    list(q?: { customer_id?: string; include_disabled?: boolean; reference_id?: string; cursor?: string }): Promise<Paged<WireCard>>
    disable(id: string): Promise<WireCard | null>
  }
  catalog: {
    upsert(key: SquareKey, object: Extra): Promise<{ object: WireCatalogObject; idMappings: { client_object_id?: string | null; object_id?: string | null }[] }>
    batchUpsert(key: SquareKey, objects: Extra[]): Promise<{ objects: WireCatalogObject[]; idMappings: { client_object_id?: string | null; object_id?: string | null }[] }>
    retrieve(id: string): Promise<WireCatalogObject>
    search(q: { object_types: string[]; cursor?: string; include_deleted_objects?: boolean }): Promise<Paged<WireCatalogObject>>
    delete(id: string): Promise<string[]>
  }
  subscriptions: {
    create(key: SquareKey, input: CreateSubscriptionInput): Promise<WireSubscription>
    retrieve(id: string, o?: { includeActions?: boolean }): Promise<WireSubscription>
    search(q: { customer_ids?: string[]; location_ids?: string[]; cursor?: string; limit?: number }): Promise<Paged<WireSubscription>>
    update(id: string, subscription: Extra): Promise<WireSubscription>
    pause(id: string, input?: Extra): Promise<{ subscription: WireSubscription; actions: WireSubscriptionAction[] }>
    resume(id: string, input?: Extra): Promise<{ subscription: WireSubscription; actions: WireSubscriptionAction[] }>
    cancel(id: string): Promise<{ subscription: WireSubscription; actions: WireSubscriptionAction[] } | null>
    swapPlan(id: string, input: Extra & { new_plan_variation_id: string }): Promise<{ subscription: WireSubscription; actions: WireSubscriptionAction[] }>
    bulkSwapPlan(input: { new_plan_variation_id: string; old_plan_variation_id: string; location_id: string }): Promise<number>
    deleteAction(id: string, actionId: string): Promise<WireSubscription | null>
  }
  invoices: {
    get(id: string): Promise<WireInvoice>
    search(q: { location_ids: string[]; customer_ids?: string[]; cursor?: string; limit?: number }): Promise<Paged<WireInvoice>>
    /** CancelInvoice (wave Q3b: a membership canceled for non-payment stops Square's retries); an open invoice only. */
    cancel(id: string, version: number): Promise<WireInvoice>
  }
  events: {
    search(q: EventSearchQuery): Promise<Paged<WireEvent>>
    enable(): Promise<void>
    disable(): Promise<void>
    listTypes(apiVersion?: string): Promise<string[]>
  }
  webhooks: {
    list(q?: { cursor?: string; include_disabled?: boolean }): Promise<Paged<WireWebhookSubscription>>
    create(key: SquareKey, input: WebhookSubscriptionInput): Promise<WireWebhookSubscription>
    update(id: string, input: Partial<WebhookSubscriptionInput>): Promise<WireWebhookSubscription>
    test(id: string, eventType?: string): Promise<{ status_code?: number | null; payload?: string | null }>
    listEventTypes(apiVersion?: string): Promise<string[]>
    /** Rotation: a new signature key, returned once. */
    rotateSignatureKey(key: SquareKey, id: string): Promise<string>
  }
}
