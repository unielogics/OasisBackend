import type { DeviceRecord, DeviceRepository, OutboxItem, OutboxRepository, ProcessedEventRepository, UsageEntry } from './types.js'

const byLaneThenAge = (a: OutboxItem, b: OutboxItem): number =>
  a.priority - b.priority || a.queuedAt.getTime() - b.queuedAt.getTime() || (a.id < b.id ? -1 : 1)

export class InMemoryOutboxRepository implements OutboxRepository {
  readonly items = new Map<string, OutboxItem>()
  readonly usage: UsageEntry[] = []
  private readonly lockedAt = new Map<string, Date>()

  async insert(item: OutboxItem): Promise<boolean> {
    if (this.items.has(item.id)) return false
    this.items.set(item.id, { ...item })
    return true
  }

  async get(id: string): Promise<OutboxItem | null> {
    const it = this.items.get(id)
    return it ? { ...it } : null
  }

  async findByProviderMessageId(providerMessageId: string): Promise<OutboxItem | null> {
    for (const it of this.items.values()) {
      if ((it.providerMessageId ?? it.id) === providerMessageId) return { ...it }
    }
    return null
  }

  async claim(id: string, at: Date): Promise<OutboxItem | null> {
    const it = this.items.get(id)
    if (!it || it.state !== 'pending') return null
    it.state = 'inflight'
    this.lockedAt.set(id, at)
    return { ...it }
  }

  async update(id: string, patch: Partial<OutboxItem>): Promise<OutboxItem> {
    const it = this.items.get(id)
    if (!it) throw new Error(`outbox item ${id} not found`)
    Object.assign(it, patch)
    if (it.state !== 'inflight') this.lockedAt.delete(id)
    return { ...it }
  }

  async listPending(): Promise<OutboxItem[]> {
    return [...this.items.values()].filter((i) => i.state === 'pending').sort(byLaneThenAge).map((i) => ({ ...i }))
  }

  async listUnconfirmed(acceptedBefore: Date, acceptedAfter: Date, reconciledBefore: Date): Promise<OutboxItem[]> {
    return [...this.items.values()]
      .filter(
        (i) =>
          (i.state === 'accepted' || i.state === 'sent') &&
          i.acceptedAt !== null &&
          i.acceptedAt <= acceptedBefore &&
          i.acceptedAt >= acceptedAfter &&
          (i.lastReconciledAt === null || i.lastReconciledAt <= reconciledBefore),
      )
      .sort((a, b) => (a.acceptedAt?.getTime() ?? 0) - (b.acceptedAt?.getTime() ?? 0))
      .map((i) => ({ ...i }))
  }

  async listStuckInflight(lockedBefore: Date): Promise<OutboxItem[]> {
    return [...this.items.values()]
      .filter((i) => i.state === 'inflight' && (this.lockedAt.get(i.id) ?? new Date(0)) <= lockedBefore)
      .map((i) => ({ ...i }))
  }

  async hasPriorOutbound(phone: string): Promise<boolean> {
    for (const it of this.items.values()) if (it.toE164 === phone) return true
    return false
  }

  async recordUsage(entry: UsageEntry): Promise<void> {
    this.usage.push({ ...entry })
  }

  async markUsageSent(providerMessageId: string, sentAt: Date): Promise<void> {
    for (const u of this.usage) if (u.providerMessageId === providerMessageId) u.sentAt = sentAt
  }

  async listUsage(since: Date): Promise<Array<{ at: Date; segments: number }>> {
    return this.usage
      .map((u) => ({ at: u.sentAt ?? u.acceptedAt, segments: u.segments }))
      .filter((u) => u.at >= since)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
  }
}

export class InMemoryDeviceRepository implements DeviceRepository {
  private readonly records = new Map<string, DeviceRecord>()

  async get(id: string): Promise<DeviceRecord | null> {
    const r = this.records.get(id)
    return r ? { ...r } : null
  }

  async save(record: DeviceRecord): Promise<void> {
    this.records.set(record.id, { ...record })
  }
}

export class InMemoryProcessedEvents implements ProcessedEventRepository {
  private readonly seen = new Set<string>()

  async markIfNew(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false
    this.seen.add(eventId)
    return true
  }

  async forget(eventId: string): Promise<void> {
    this.seen.delete(eventId)
  }
}
