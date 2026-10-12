import type { SquareSimStore } from './store.js'

/**
 * A small demo merchant for `pnpm sim:square --seed demo`: a client with a saved card, a counter (POS) card payment with a tip and
 * an invoice number in the note, a cash counter payment, and an open payment link. Nothing here is used by tests.
 */
export function seedSquareDemo(store: SquareSimStore): { customerId: string; cardId: string; linkId: string } {
  const c = store.createCustomer({
    given_name: 'Maria',
    family_name: 'Alvarez',
    email_address: 'maria.alvarez@oasisautospanj.com',
    phone_number: '+15557120188',
    reference_id: 'demo-client-1',
  })
  const card = store.createCard({ source_id: 'cnon:card-nonce-ok', card: { customer_id: c.id, cardholder_name: 'Maria Alvarez', billing_address: { postal_code: '07026' } } })
  store.posPayment({ amountCents: 4000, tipCents: 600, note: 'INV-20640', sourceType: 'CARD' })
  store.posPayment({ amountCents: 2500, sourceType: 'CASH' })
  const { link } = store.createLink({
    order: { location_id: store.locationId, reference_id: 'INV-20641', line_items: [{ name: 'Signature Hand Wash', quantity: '1', base_price_money: { amount: 4000, currency: 'USD' } }, { name: 'Sales tax', quantity: '1', base_price_money: { amount: 265, currency: 'USD' } }] },
    payment_note: 'INV-20641',
  })
  return { customerId: String(c.id), cardId: String(card.id), linkId: String(link.id) }
}
