import { sql, type Selectable } from 'kysely'
import type { Executor } from '../../../platform/db.js'
import { isUuid } from '../../../platform/ids.js'
import type { SmsPriority } from '../../../integrations/ports/sms.js'
import type { SmsEncoding } from '../../../integrations/sms/gsm.js'
import type { OutboxItem, OutboxRepository, OutboxState, UsageEntry } from '../dispatch/types.js'
import type { SmsClass } from '../policy/classes.js'
import type { SmsOutboxTable } from '../schema.js'
import { inTx } from './exec.js'
import { syncMessageFromOutbox } from './messages.js'

type Row = Selectable<SmsOutboxTable>

export function itemOf(r: Row): OutboxItem {
  return {
    id: r.id,
    messageId: r.message_id,
    toE164: r.to_e164,
    body: r.body,
    encoding: r.encoding as SmsEncoding,
    segments: r.segments,
    klass: r.klass as SmsClass,
    priority: r.priority as SmsPriority,
    state: r.state as OutboxState,
    attempts: r.attempts,
    deviceFailures: r.device_failures,
    reconcileResends: r.reconcile_resends,
    nextAttemptAt: r.next_attempt_at,
    providerMessageId: r.provider_message_id,
    deviceId: r.device_id,
    ...(r.sim_slot !== null ? { simSlot: r.sim_slot } : {}),
    lastError: r.last_error,
    queuedAt: r.queued_at,
    ttlAt: r.ttl_at,
    holdUntil: r.hold_until,
    acceptedAt: r.accepted_at,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
    failedAt: r.failed_at,
    lastReconciledAt: r.last_reconciled_at,
  }
}

const COLUMN_OF: Record<keyof OutboxItem, string> = {
  id: 'id',
  messageId: 'message_id',
  toE164: 'to_e164',
  body: 'body',
  encoding: 'encoding',
  segments: 'segments',
  klass: 'klass',
  priority: 'priority',
  state: 'state',
  attempts: 'attempts',
  deviceFailures: 'device_failures',
  reconcileResends: 'reconcile_resends',
  nextAttemptAt: 'next_attempt_at',
  providerMessageId: 'provider_message_id',
  deviceId: 'device_id',
  simSlot: 'sim_slot',
  lastError: 'last_error',
  queuedAt: 'queued_at',
  ttlAt: 'ttl_at',
  holdUntil: 'hold_until',
  acceptedAt: 'accepted_at',
  sentAt: 'sent_at',
  deliveredAt: 'delivered_at',
  failedAt: 'failed_at',
  lastReconciledAt: 'last_reconciled_at',
}

export function rowValues(item: OutboxItem): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item) as Array<[keyof OutboxItem, unknown]>) out[COLUMN_OF[k]] = v === undefined ? null : v
  return out
}

export interface PgOutboxOptions {
  /** The device this repository serves: its pending items and any not yet assigned to a device. Null serves all. */
  deviceId: string | null
}

const PENDING_LIMIT = 2000

/**
 * sms_outbox behind the dispatcher's OutboxRepository. Given a transaction every call joins it; given a plain connection
 * each call is atomic by itself. claim() is a single UPDATE guarded by FOR UPDATE SKIP LOCKED, so two dispatchers can
 * never take the same message. update() also mirrors the new state onto the message row (and publishes message.status).
 */
export class PgOutboxRepository implements OutboxRepository {
  constructor(
    private readonly exec: Executor,
    private readonly o: PgOutboxOptions,
  ) {}

  async insert(item: OutboxItem): Promise<boolean> {
    const r = await this.exec
      .insertInto('sms_outbox')
      .values(rowValues(item) as never)
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirst()
    return Number(r.numInsertedOrUpdatedRows ?? 0n) > 0
  }

  async get(id: string): Promise<OutboxItem | null> {
    const r = await this.exec.selectFrom('sms_outbox').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? itemOf(r) : null
  }

  /**
   * Inside a transaction the row is locked, so two webhook events for one message (sent and delivered arrive together) are
   * applied one after the other, each deciding on the state the previous one committed.
   */
  async findByProviderMessageId(providerMessageId: string): Promise<OutboxItem | null> {
    const base = this.exec.selectFrom('sms_outbox').selectAll()
    const q = this.exec.isTransaction ? base.forUpdate() : base
    const r = await (isUuid(providerMessageId)
      ? q.where((eb) =>
          eb.or([
            eb('provider_message_id', '=', providerMessageId),
            eb.and([eb('provider_message_id', 'is', null), eb('id', '=', providerMessageId)]),
          ]),
        )
      : q.where('provider_message_id', '=', providerMessageId)
    ).executeTakeFirst()
    return r ? itemOf(r) : null
  }

  async claim(id: string, at: Date): Promise<OutboxItem | null> {
    const r = await sql<Row>`
      update sms_outbox set state = 'inflight', locked_at = ${at}, device_id = coalesce(device_id, ${this.o.deviceId}::uuid)
      where id = (select id from sms_outbox where id = ${id} and state = 'pending' for update skip locked)
      returning *`.execute(this.exec)
    const row = r.rows[0]
    if (!row) return null
    // a Date from raw SQL is already a Date (pg parses timestamptz); the shape matches Selectable<SmsOutboxTable>
    await inTx(this.exec, (tx) => syncMessageFromOutbox(tx, row))
    return itemOf(row)
  }

  async update(id: string, patch: Partial<OutboxItem>): Promise<OutboxItem> {
    const set: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch) as Array<[keyof OutboxItem, unknown]>) {
      if (k === 'id' || k === 'messageId') continue
      set[COLUMN_OF[k]] = v === undefined ? null : v
    }
    if (patch.state !== undefined && patch.state !== 'inflight') set.locked_at = null
    return inTx(this.exec, async (tx) => {
      if (patch.state === 'accepted') {
        // The device can report sent or delivered before the send call returns: never move a message backwards to accepted.
        const cur = await tx.selectFrom('sms_outbox').select('state').where('id', '=', id).forUpdate().executeTakeFirst()
        if (cur && cur.state !== 'inflight' && cur.state !== 'accepted') delete set.state
      }
      const row = await tx
        .updateTable('sms_outbox')
        .set(set as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst()
      if (!row) throw new Error(`outbox item ${id} not found`)
      await syncMessageFromOutbox(tx, row)
      return itemOf(row)
    })
  }

  async listPending(): Promise<OutboxItem[]> {
    let q = this.exec.selectFrom('sms_outbox').selectAll().where('state', '=', 'pending')
    if (this.o.deviceId) q = q.where((eb) => eb.or([eb('device_id', '=', this.o.deviceId!), eb('device_id', 'is', null)]))
    const rows = await q.orderBy('priority').orderBy('queued_at').orderBy('id').limit(PENDING_LIMIT).execute()
    return rows.map(itemOf)
  }

  async listUnconfirmed(acceptedBefore: Date, acceptedAfter: Date, reconciledBefore: Date): Promise<OutboxItem[]> {
    let q = this.exec
      .selectFrom('sms_outbox')
      .selectAll()
      .where('state', 'in', ['accepted', 'sent'])
      .where('accepted_at', '<=', acceptedBefore)
      .where('accepted_at', '>=', acceptedAfter)
      .where((eb) => eb.or([eb('last_reconciled_at', 'is', null), eb('last_reconciled_at', '<=', reconciledBefore)]))
    if (this.o.deviceId) q = q.where('device_id', '=', this.o.deviceId)
    return (await q.orderBy('accepted_at').limit(200).execute()).map(itemOf)
  }

  async listStuckInflight(lockedBefore: Date): Promise<OutboxItem[]> {
    let q = this.exec
      .selectFrom('sms_outbox')
      .selectAll()
      .where('state', '=', 'inflight')
      .where((eb) => eb.or([eb('locked_at', 'is', null), eb('locked_at', '<=', lockedBefore)]))
    if (this.o.deviceId) q = q.where((eb) => eb.or([eb('device_id', '=', this.o.deviceId!), eb('device_id', 'is', null)]))
    return (await q.limit(200).execute()).map(itemOf)
  }

  async hasPriorOutbound(phone: string): Promise<boolean> {
    const r = await this.exec.selectFrom('sms_outbox').select('id').where('to_e164', '=', phone).limit(1).executeTakeFirst()
    return r !== undefined
  }

  async reassignedAmong(ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set()
    const rows = await this.exec
      .selectFrom('sms_outbox as o')
      .innerJoin('messages as m', 'm.id', 'o.message_id')
      .innerJoin('customers as c', 'c.id', 'm.customer_id')
      .select('o.id')
      .where('o.id', 'in', ids)
      .where(sql<boolean>`c.phone_e164 is distinct from o.to_e164`)
      .execute()
    return new Set(rows.map((r) => r.id))
  }

  async suppressedAmong(phones: readonly string[]): Promise<{ optedOut: ReadonlySet<string>; notConsented: ReadonlySet<string> }> {
    const none = { optedOut: new Set<string>(), notConsented: new Set<string>() }
    if (phones.length === 0) return none
    const outs = await this.exec.selectFrom('sms_opt_outs').select('phone_e164').where('phone_e164', 'in', phones).where('opted_in_again_at', 'is', null).execute()
    const people = await this.exec
      .selectFrom('customers')
      .select(['phone_e164', 'sms_opted_in', 'sms_opted_out_at'])
      .where('phone_e164', 'in', phones)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .execute()
    for (const r of outs) none.optedOut.add(r.phone_e164)
    for (const c of people) {
      if (c.sms_opted_out_at !== null) none.optedOut.add(c.phone_e164!)
      if (!c.sms_opted_in) none.notConsented.add(c.phone_e164!)
    }
    return none
  }

  async recordUsage(entry: UsageEntry): Promise<void> {
    await this.exec
      .insertInto('sms_usage')
      .values({
        device_id: this.o.deviceId,
        provider_message_id: entry.providerMessageId,
        segments: entry.segments,
        accepted_at: entry.acceptedAt,
        sent_at: entry.sentAt ?? null,
      })
      .execute()
  }

  async markUsageSent(providerMessageId: string, sentAt: Date): Promise<void> {
    await this.exec.updateTable('sms_usage').set({ sent_at: sentAt }).where('provider_message_id', '=', providerMessageId).execute()
  }

  async listUsage(since: Date): Promise<Array<{ at: Date; segments: number }>> {
    const r = await sql<{ at: Date; segments: number }>`
      select coalesce(sent_at, accepted_at) as at, segments from sms_usage
      where coalesce(sent_at, accepted_at) >= ${since}
        and (${this.o.deviceId}::uuid is null or device_id = ${this.o.deviceId}::uuid)
      order by 1`.execute(this.exec)
    return r.rows.map((x) => ({ at: x.at, segments: x.segments }))
  }
}
