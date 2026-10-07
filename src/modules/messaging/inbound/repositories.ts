import type { AppointmentRef } from './attribution.js'
import type { InboundDecision, InboundText } from './router.js'

export interface InboxRow {
  id: string
  deviceId: string
  providerMessageId: string
  fromRaw: string
  fromE164: string | null
  body: string
  deviceReceivedAt: Date
  receivedAt: Date
  processedAt: Date | null
  decision: InboundDecision['kind'] | null
  quarantined: boolean
}

export interface InboxRepository {
  /** Inserts the received text, unique on (deviceId, providerMessageId). `inserted` is false for a repeat. */
  insertIfNew(msg: InboundText, receivedAt: Date): Promise<{ inserted: boolean; row: InboxRow }>
  markProcessed(id: string, decision: InboundDecision['kind'], quarantined: boolean, at: Date): Promise<void>
}

export interface CustomerDirectory {
  findByPhone(phone: string): Promise<{ id: string; firstName?: string } | null>
  listAppointments(customerId: string): Promise<AppointmentRef[]>
}

export class InMemoryInboxRepository implements InboxRepository {
  readonly rows: InboxRow[] = []

  async insertIfNew(msg: InboundText, receivedAt: Date): Promise<{ inserted: boolean; row: InboxRow }> {
    const found = this.rows.find(
      (r) => r.deviceId === msg.deviceId && r.providerMessageId === msg.providerMessageId,
    )
    if (found) return { inserted: false, row: found }
    const row: InboxRow = {
      id: `inbox-${this.rows.length + 1}`,
      deviceId: msg.deviceId,
      providerMessageId: msg.providerMessageId,
      fromRaw: msg.from,
      fromE164: null,
      body: msg.body,
      deviceReceivedAt: msg.receivedAt,
      receivedAt,
      processedAt: null,
      decision: null,
      quarantined: false,
    }
    this.rows.push(row)
    return { inserted: true, row }
  }

  async markProcessed(
    id: string,
    decision: InboundDecision['kind'],
    quarantined: boolean,
    at: Date,
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (!row) return
    row.processedAt = at
    row.decision = decision
    row.quarantined = quarantined
  }
}

export class InMemoryCustomerDirectory implements CustomerDirectory {
  readonly customers = new Map<string, { id: string; firstName?: string; appointments: AppointmentRef[] }>()

  add(
    phone: string,
    customer: { id: string; firstName?: string },
    appointments: AppointmentRef[] = [],
  ): void {
    this.customers.set(phone, { ...customer, appointments })
  }

  async findByPhone(phone: string): Promise<{ id: string; firstName?: string } | null> {
    const c = this.customers.get(phone)
    return c ? { id: c.id, firstName: c.firstName } : null
  }

  async listAppointments(customerId: string): Promise<AppointmentRef[]> {
    for (const c of this.customers.values())
      if (c.id === customerId) return c.appointments.map((a) => ({ ...a }))
    return []
  }
}
