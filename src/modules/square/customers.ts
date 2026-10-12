// The client's Square customer (ADR 0171 D7, design 4.2 step 2). A saved card and a subscription belong to a Square customer, so
// before either Oasis makes sure the client has exactly one:
//   1. square_customer_links (location, client): the one we linked before;
//   2. else SearchCustomers by reference_id = the client's uuid (a customer created by an earlier attempt that crashed before the
//      link was written): linked as `found`;
//   3. else CreateCustomer with the key cu_<client id> (a retry answers the same customer; the body holds only the client's name,
//      number and reference_id = the client's uuid, so a retry is the same request): linked as `created`.
// The Square calls run outside any transaction; the link is written in its own short one (the first writer wins: a concurrent call
// that linked another Square customer meanwhile is answered with the stored one). An email is optional here (a saved card needs none);
// a membership passes the email Square bills to, and an existing customer without that email is updated (UpdateCustomer).
// Writes off (SQUARE_WRITES_ENABLED=false): the search still runs, CreateCustomer and UpdateCustomer throw SquareWritesDisabled.
import type { SquareApi } from '../../integrations/ports/square.js'
import { sqKey } from '../../integrations/square/keys.js'
import type { WireCustomer } from '../../integrations/square/wire.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import type { SquareCustomerLinkedBy } from './db/cards-schema.js'
import './db/cards-schema.js'
import './problems.js'

export interface SquareCustomerDeps {
  db: Db
  clock: Clock
  newId: NewId
  api: SquareApi
  locationId: string
}

export interface EnsureSquareCustomerInput {
  customerId: string
  /** The email Square should hold (memberships: Square bills to it). Optional for a saved card. */
  email?: string | null
}

export interface EnsuredSquareCustomer {
  squareCustomerId: string
  linkedBy: SquareCustomerLinkedBy
  /** This call created the customer at Square. */
  created: boolean
  /** This call set the email at Square (UpdateCustomer). */
  emailUpdated: boolean
}

/** "Maria Delgado" -> given Maria, family Delgado; one word -> given only. */
export function splitName(full: string): { given_name?: string; family_name?: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return {}
  if (parts.length === 1) return { given_name: parts[0]!.slice(0, 300) }
  return { given_name: parts[0]!.slice(0, 300), family_name: parts.slice(1).join(' ').slice(0, 300) }
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/**
 * The client's Square customer id, linking (and creating at Square) when needed. 404 NOT_FOUND for a client that does not exist (or
 * was merged or deleted). Square errors propagate (SquareWritesDisabled, SquareNetworkError, SquareApiError): the caller maps them.
 */
export async function ensureSquareCustomer(deps: SquareCustomerDeps, input: EnsureSquareCustomerInput): Promise<EnsuredSquareCustomer> {
  const { db, api, locationId } = deps
  const email = input.email?.trim() || null
  const linked = await db
    .selectFrom('square_customer_links')
    .select(['square_customer_id', 'linked_by'])
    .where('location_id', '=', locationId)
    .where('customer_id', '=', input.customerId)
    .executeTakeFirst()
  if (linked) {
    const emailUpdated = email ? await ensureEmail(api, linked.square_customer_id, email) : false
    return { squareCustomerId: linked.square_customer_id, linkedBy: linked.linked_by, created: false, emailUpdated }
  }

  const client = await db
    .selectFrom('customers')
    .select(['id', 'full_name', 'phone_e164'])
    .where('id', '=', input.customerId)
    .where('merged_into', 'is', null)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!client) throw new AppError('NOT_FOUND', { detail: 'That client does not exist' })

  let found: WireCustomer | undefined = (await api.customers.search({ reference_id: client.id, limit: 10 })).items
    .filter((c) => c.reference_id === client.id)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0]
  let created = false
  if (!found) {
    // the body depends only on the client (never on the email of this request), so a retry with the same key is the same request
    found = await api.customers.create(sqKey('cu', client.id), {
      ...splitName(client.full_name),
      ...(client.phone_e164 ? { phone_number: client.phone_e164 } : {}),
      reference_id: client.id,
    })
    created = true
  }
  let emailUpdated = false
  if (email && !sameEmail(found.email_address, email)) {
    await api.customers.update(found.id, { email_address: email })
    emailUpdated = true
  }

  const linkedBy: SquareCustomerLinkedBy = created ? 'created' : 'found'
  const squareCustomerId = found.id
  const stored = await transaction(db, async (tx) => {
    await tx
      .insertInto('square_customer_links')
      .values({
        id: deps.newId(),
        location_id: locationId,
        customer_id: client.id,
        square_customer_id: squareCustomerId,
        linked_by: linkedBy,
        created_at: deps.clock.now(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
    return tx
      .selectFrom('square_customer_links')
      .select(['square_customer_id', 'linked_by', 'customer_id'])
      .where('location_id', '=', locationId)
      .where((eb) => eb.or([eb('customer_id', '=', client.id), eb('square_customer_id', '=', squareCustomerId)]))
      .execute()
  })
  const mine = stored.find((r) => r.customer_id === client.id)
  // the Square customer is already another client's (a merge left two Oasis clients on one Square customer): refuse, never share
  if (!mine) throw new AppError('SQUARE_CUSTOMER_TAKEN')
  return {
    squareCustomerId: mine.square_customer_id,
    linkedBy: mine.linked_by,
    created: created && mine.square_customer_id === squareCustomerId,
    emailUpdated,
  }
}

/** Sets the email at Square when it is missing or different; true when it changed it. */
async function ensureEmail(api: SquareApi, squareCustomerId: string, email: string): Promise<boolean> {
  const c = await api.customers.retrieve(squareCustomerId)
  if (sameEmail(c.email_address, email)) return false
  await api.customers.update(squareCustomerId, { email_address: email })
  return true
}
