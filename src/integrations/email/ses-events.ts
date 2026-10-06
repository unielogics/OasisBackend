import { z } from 'zod'
import { normalizeAddress } from './mime.js'

// Pure parsing of SES bounce / complaint / delivery notifications (SNS "notification" format or the
// event-publishing format, which names the discriminator `eventType`) and the resulting suppression decisions.
// SES may add fields at any time, so every object is passthrough and only what we use is validated.

const recipient = z
  .object({
    emailAddress: z.string(),
    status: z.string().optional(),
    action: z.string().optional(),
    diagnosticCode: z.string().optional(),
  })
  .passthrough()

const mail = z.object({ messageId: z.string().min(1), timestamp: z.string().optional() }).passthrough()

const notification = z
  .object({
    notificationType: z.string().optional(),
    eventType: z.string().optional(),
    mail,
    bounce: z
      .object({
        bounceType: z.string(),
        bounceSubType: z.string().optional(),
        bouncedRecipients: z.array(recipient).default([]),
        timestamp: z.string().optional(),
        feedbackId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    complaint: z
      .object({
        complainedRecipients: z.array(z.object({ emailAddress: z.string() }).passthrough()).default([]),
        complaintFeedbackType: z.string().optional(),
        complaintSubType: z.string().nullable().optional(),
        timestamp: z.string().optional(),
        feedbackId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    delivery: z
      .object({ recipients: z.array(z.string()).default([]), timestamp: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type FeedbackAction = 'suppress' | 'soft_bounce' | 'delivered'
export type FeedbackReason = 'hard_bounce' | 'complaint' | 'soft_bounce' | 'delivered'

export interface FeedbackDecision {
  action: FeedbackAction
  reason: FeedbackReason
  /** Lowercased recipient address: the suppression-list key. */
  address: string
  /** SES message id, as returned by SendEmail and stored in outbox_emails.ses_message_id. */
  messageId: string
  feedbackId?: string
  at: Date | null
  bounceType?: string
  bounceSubType?: string
  complaintFeedbackType?: string
  diagnostic?: string
}

export class SesNotificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SesNotificationError'
  }
}

const date = (s: string | undefined): Date | null => {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** DSN Final-Recipient values can arrive as `Name <a@b.c>`; keep only the address. */
export function extractAddress(raw: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(raw)
  const addr = normalizeAddress(m?.[1] ?? raw.replace(/^rfc822;\s*/i, ''))
  return /^[^\s@<>]+@[^\s@<>]+$/.test(addr) ? addr : null
}

/**
 * Turns one SES notification (JSON text or object) into per-recipient decisions.
 * Hard bounces (Permanent, any subtype) and complaints suppress; Transient/Undetermined bounces are recorded as
 * soft bounces (the caller decides whether N in a row suppress); deliveries confirm. Event types other than
 * Bounce, Complaint and Delivery (Send, Open, DeliveryDelay, ...) yield no decisions.
 */
export function decideFromNotification(message: string | object): FeedbackDecision[] {
  let obj: unknown = message
  if (typeof message === 'string') {
    try {
      obj = JSON.parse(message)
    } catch {
      throw new SesNotificationError('notification is not valid JSON')
    }
  }
  const parsed = notification.safeParse(obj)
  if (!parsed.success) throw new SesNotificationError('notification does not look like an SES event')
  const n = parsed.data
  const type = n.notificationType ?? n.eventType
  const messageId = n.mail.messageId
  const out: FeedbackDecision[] = []

  if (type === 'Bounce' && n.bounce) {
    const b = n.bounce
    const hard = b.bounceType === 'Permanent'
    for (const r of b.bouncedRecipients) {
      const address = extractAddress(r.emailAddress)
      if (!address) continue
      out.push({
        action: hard ? 'suppress' : 'soft_bounce',
        reason: hard ? 'hard_bounce' : 'soft_bounce',
        address,
        messageId,
        ...(b.feedbackId ? { feedbackId: b.feedbackId } : {}),
        at: date(b.timestamp),
        bounceType: b.bounceType,
        ...(b.bounceSubType ? { bounceSubType: b.bounceSubType } : {}),
        ...(r.diagnosticCode ? { diagnostic: r.diagnosticCode.slice(0, 500) } : {}),
      })
    }
  } else if (type === 'Complaint' && n.complaint) {
    const c = n.complaint
    // A not-spam report corrects an earlier misclassification; it is not a reason to stop sending.
    if (c.complaintFeedbackType !== 'not-spam') {
      for (const r of c.complainedRecipients) {
        const address = extractAddress(r.emailAddress)
        if (!address) continue
        out.push({
          action: 'suppress',
          reason: 'complaint',
          address,
          messageId,
          ...(c.feedbackId ? { feedbackId: c.feedbackId } : {}),
          at: date(c.timestamp),
          ...(c.complaintFeedbackType ? { complaintFeedbackType: c.complaintFeedbackType } : {}),
        })
      }
    }
  } else if (type === 'Delivery' && n.delivery) {
    for (const raw of n.delivery.recipients) {
      const address = extractAddress(raw)
      if (!address) continue
      out.push({
        action: 'delivered',
        reason: 'delivered',
        address,
        messageId,
        at: date(n.delivery.timestamp),
      })
    }
  }
  return out
}
