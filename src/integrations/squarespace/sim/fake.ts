import type {
  Page,
  SqspContact,
  SqspOrder,
  SqspTransaction,
  SquarespaceSource,
} from '../../ports/squarespace.js'
import { mapContact, mapOrder, mapTransactionDocument, type MapOptions } from '../mappers.js'
import { SquarespaceSimStore } from './store.js'
import { SquarespaceNotFoundError } from '../errors.js'

/**
 * In-process SquarespaceSource over the simulator store: no HTTP, same query semantics, same mappers.
 * For unit tests of the sync engine and matcher that do not need transport behaviour.
 */
export class InProcessSquarespace implements SquarespaceSource {
  constructor(
    readonly store: SquarespaceSimStore,
    private readonly mapOpts: MapOptions = {},
  ) {}

  async listOrders(p: {
    modifiedAfter: Date
    modifiedBefore: Date
    cursor?: string
  }): Promise<Page<SqspOrder>> {
    const page = this.store.queryOrders(
      p.cursor
        ? { cursor: p.cursor }
        : {
            modifiedAfter: p.modifiedAfter.toISOString(),
            modifiedBefore: p.modifiedBefore.toISOString(),
            paymentStates:
              'NOT_CHARGED,AUTHORIZED,PAID,PARTIALLY_PAID,PENDING,FAILED,REFUND_PENDING,REFUNDED,REFUND_FAILED',
          },
    )
    return { items: page.rows.map((o) => mapOrder(o, this.mapOpts)), nextCursor: page.nextCursor }
  }

  async getOrder(id: string): Promise<SqspOrder> {
    try {
      return mapOrder(this.store.getOrder(id), this.mapOpts)
    } catch (e) {
      throw new SquarespaceNotFoundError(
        404,
        { message: e instanceof Error ? e.message : String(e) },
        'GET',
        id,
      )
    }
  }

  async listTransactions(p: {
    modifiedAfter: Date
    modifiedBefore: Date
    cursor?: string
  }): Promise<Page<SqspTransaction>> {
    const page = this.store.queryDocuments(
      p.cursor
        ? { cursor: p.cursor }
        : { modifiedAfter: p.modifiedAfter.toISOString(), modifiedBefore: p.modifiedBefore.toISOString() },
    )
    return { items: page.rows.flatMap((d) => mapTransactionDocument(d)), nextCursor: page.nextCursor }
  }

  async listContacts(p: { cursor?: string }): Promise<Page<SqspContact>> {
    const page = this.store.queryContacts({ cursor: p.cursor, pageSize: 500 })
    return { items: page.rows.map(mapContact), nextCursor: page.nextCursor }
  }
}
