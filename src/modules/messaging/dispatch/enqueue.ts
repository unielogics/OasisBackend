import { prepareSmsBody } from '../../../integrations/sms/gsm.js'
import { expiryFor, prepareOutboundBody } from '../policy/body.js'
import { canSendSms, type SmsDecision, type SmsDenyReason, type SmsPolicyContext } from '../policy/canSend.js'
import { classSpec } from '../policy/classes.js'
import type { DispatcherConfig, EnqueueInput } from './dispatcher.js'
import type { OutboxItem } from './types.js'

export type EnqueuePlan =
  | { status: 'ready'; item: OutboxItem; holdUntil: Date | null; warnings: string[] }
  | { status: 'suppressed'; reason: SmsDenyReason }
  | { status: 'rejected'; reason: 'too_long' | 'empty'; segments?: number }

export type PlanConfig = Pick<
  DispatcherConfig,
  'maxSegments' | 'simSlot' | 'quietHours' | 'environment' | 'allowlist'
> & {
  /** The device the item is pinned to; null leaves it for whichever dispatcher claims it first. */
  deviceId: string | null
}

/**
 * Everything enqueue decides before touching storage: the policy gate, GSM-7 normalisation, the STOP footer, the segment
 * count, the quiet-hours hold and the expiry. Pure apart from `hasPriorOutbound`, which drives the first-message footer.
 * The in-memory Dispatcher and the transactional DbMessageQueue share it, so both apply exactly the same rules.
 */
export async function planEnqueue(
  input: EnqueueInput,
  deps: { now: Date; cfg: PlanConfig; hasPriorOutbound(phone: string): Promise<boolean> },
): Promise<EnqueuePlan> {
  const { now, cfg } = deps
  if (input.text.trim().length === 0) return { status: 'rejected', reason: 'empty' }

  const ctx: SmsPolicyContext = {
    now,
    environment: cfg.environment,
    allowlist: cfg.allowlist,
    quietHours: cfg.quietHours,
  }
  const decision: SmsDecision = canSendSms(input.recipient, { klass: input.klass }, ctx)
  if (decision.verdict === 'deny') return { status: 'suppressed', reason: decision.reason }
  const phone = input.recipient.phone as string // canSendSms denies when there is no number

  if (prepareSmsBody(input.text, undefined).body.length === 0) return { status: 'rejected', reason: 'empty' }
  const first = !(await deps.hasPriorOutbound(phone))
  const prepared = prepareOutboundBody(input.text, input.klass, { firstMessageToNumber: first })
  if (prepared.segments > cfg.maxSegments)
    return { status: 'rejected', reason: 'too_long', segments: prepared.segments }

  const holdUntil = decision.verdict === 'hold' ? decision.holdUntil : null
  const item: OutboxItem = {
    id: input.messageId,
    messageId: input.messageId,
    toE164: phone,
    body: prepared.body,
    encoding: prepared.encoding,
    segments: prepared.segments,
    klass: input.klass,
    priority: input.priority ?? classSpec(input.klass).priority,
    state: 'pending',
    attempts: 0,
    deviceFailures: 0,
    reconcileResends: 0,
    nextAttemptAt: holdUntil,
    providerMessageId: null,
    deviceId: cfg.deviceId,
    simSlot: input.simSlot ?? cfg.simSlot,
    lastError: null,
    queuedAt: now,
    ttlAt: expiryFor(input.klass, now, holdUntil, input.ttlOverrideSec),
    holdUntil,
    acceptedAt: null,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    lastReconciledAt: null,
  }
  return { status: 'ready', item, holdUntil, warnings: decision.warnings }
}
