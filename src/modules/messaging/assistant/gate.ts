// The assistant gate on Postgres (ADR 0160, design section 3): may the AI answer this inbound text? Consulted by the inbound
// service before routing (and by the turn again, wave 3). Every check must pass, in this order:
//   AI_ENABLED (environment) -> settings assistant.enabled -> a real sender that is not ours -> a US/CA mobile number
//   (normalizeTextableNanp) -> the stage (allowlist | customers | everyone) -> not opted out (the number or its client)
//   = `active` (AGENT is a handoff from here on)
//   -> the thread is not paused by a staff reply -> no open handoff -> the loop breakers   = `allow`
// With AI_ENABLED=false the gate answers without touching the database.
import type { Executor } from '../../../platform/db.js'
import { normalizeTextableNanp } from '../../../platform/phone.js'
import { getSetting } from '../../../platform/settings.js'
import type { AssistantGate, AssistantGateInput, AssistantGateReason, AssistantGateVerdict } from '../../assistant/ports.js'
import { normalizeE164 } from '../../../integrations/sms/phone.js'
import { LOOP_LOOKBACK_MS, loopBreaker, senderBreaker, type RecentInbound } from './loop-breakers.js'
import '../schema.js'
import '../../assistant/schema.js'

export interface AssistantGateConfig {
  /** AI_ENABLED. */
  aiEnabled: boolean
  /** The shop's own numbers (BUSINESS_PHONE and the like), E.164 or anything normalizeE164 reads. */
  ownNumbers: readonly string[]
}

const no = (reason: AssistantGateReason, active = false): AssistantGateVerdict => ({ active, allow: false, reason })

/** How many of the number's latest texts the loop breakers look at (more than any breaker needs). */
const LOOKBACK_ROWS = 50

export function createAssistantGate(cfg: AssistantGateConfig): AssistantGate {
  const own = cfg.ownNumbers.map((n) => normalizeE164(n)).filter((n): n is string => n !== null)
  return {
    async evaluate(db: Executor, i: AssistantGateInput): Promise<AssistantGateVerdict> {
      if (!cfg.aiEnabled) return no('ai_disabled')
      if (!(await getSetting(db, i.locationId, 'assistant.enabled')).value) return no('assistant_disabled')

      const to = i.to ? normalizeE164(i.to) : null
      const sender = senderBreaker(i.from, i.phone, to ? [...own, to] : own)
      if (sender || i.phone === null) return no(sender ?? 'loop_sender')
      const phone = i.phone
      const textable = normalizeTextableNanp(phone)
      if (!textable.ok) return no('not_textable')

      const stage = (await getSetting(db, i.locationId, 'assistant.stage')).value
      if (stage === 'allowlist') {
        const list = (await getSetting(db, i.locationId, 'assistant.allowlist')).value
        if (!list.includes(phone)) return no('not_in_stage')
      } else if (stage === 'customers' && i.customerId === null) return no('not_in_stage')

      if (i.optedOut) return no('opted_out')
      if (i.customerId) {
        const c = await db.selectFrom('customers').select('sms_opted_out_at').where('id', '=', i.customerId).executeTakeFirst()
        if (c?.sms_opted_out_at) return no('opted_out')
      }

      // active from here: AGENT is a handoff; what follows only holds the AI back for now
      if (i.customerId) {
        const paused = await db
          .selectFrom('message_threads')
          .select('id')
          .where('location_id', '=', i.locationId)
          .where('customer_id', '=', i.customerId)
          .where('ai_paused_until', '>', i.now)
          .executeTakeFirst()
        if (paused) return no('thread_paused', true)
      }
      const handoff = await db
        .selectFrom('assistant_conversations')
        .select('id')
        .where('location_id', '=', i.locationId)
        .where('phone_e164', '=', phone)
        .where('handoff_state', '=', 'open')
        .executeTakeFirst()
      if (handoff) return no('handoff_open', true)

      const recent = await recentInbound(db, i.locationId, phone, i.now)
      const loop = loopBreaker({ from: i.from, phone, ownNumbers: own, body: i.body, now: i.now, recent })
      if (loop) return no(loop, true)
      return { active: true, allow: true, reason: null }
    },
  }
}

/** The number's texts of the last LOOP_LOOKBACK_MS at this location (the one being routed included: it is filed first). */
export async function recentInbound(db: Executor, locationId: string, phone: string, now: Date): Promise<RecentInbound[]> {
  const rows = await db
    .selectFrom('sms_inbox as i')
    .innerJoin('sms_devices as d', 'd.id', 'i.device_id')
    .select(['i.body', 'i.received_at'])
    .where('d.location_id', '=', locationId)
    .where('i.from_e164', '=', phone)
    .where('i.received_at', '>', new Date(now.getTime() - LOOP_LOOKBACK_MS))
    .where('i.received_at', '<=', now)
    // an incomplete-MMS placeholder and its complete delivery are one text
    .where('i.superseded_by', 'is', null)
    .orderBy('i.received_at', 'desc')
    .limit(LOOKBACK_ROWS)
    .execute()
  return rows.map((r) => ({ body: r.body, at: r.received_at }))
}

