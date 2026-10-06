// Opt-outs are keyed by phone number (E.164), not by customer: a STOP from a number we have no customer for still counts.

export type OptOutSource = 'keyword' | 'manual' | 'import'

export interface OptOutRecord {
  phone: string
  optedOutAt: Date
  source: OptOutSource
  keyword?: string
  inboundMessageId?: string
  optedInAgainAt: Date | null
}

export interface OptOutRepository {
  /** The active opt-out for the number, if any (a record whose optedInAgainAt is null). */
  findActive(phone: string): Promise<OptOutRecord | null>
  /** Records an opt-out. Idempotent: a second STOP while one is active changes nothing. */
  optOut(record: Omit<OptOutRecord, 'optedInAgainAt'>): Promise<{ created: boolean }>
  /** Clears the active opt-out. Returns whether one was active. */
  optIn(phone: string, at: Date): Promise<{ wasOptedOut: boolean }>
}

export class InMemoryOptOutRepository implements OptOutRepository {
  readonly records: OptOutRecord[] = []

  async findActive(phone: string): Promise<OptOutRecord | null> {
    return this.records.find((r) => r.phone === phone && r.optedInAgainAt === null) ?? null
  }

  async optOut(record: Omit<OptOutRecord, 'optedInAgainAt'>): Promise<{ created: boolean }> {
    if (await this.findActive(record.phone)) return { created: false }
    this.records.push({ ...record, optedInAgainAt: null })
    return { created: true }
  }

  async optIn(phone: string, at: Date): Promise<{ wasOptedOut: boolean }> {
    const active = await this.findActive(phone)
    if (!active) return { wasOptedOut: false }
    active.optedInAgainAt = at
    return { wasOptedOut: true }
  }
}
