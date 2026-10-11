// SmsProvider: the only way the app sends or receives texts. Adapters: SMS Gate (tablet over the tailnet) and a simulator.
export type SmsPriority = 0 | 1 | 2 | 3 // 0 transactional/urgent ... 3 bulk

export interface SmsSendRequest {
  /** Our messages.id, passed through as the provider message id so a retry can never double-send. */
  id: string
  to: string // E.164
  body: string
  simSlot?: number
  ttlSec?: number
  priority?: SmsPriority
}

export type SmsState = 'Pending' | 'Processed' | 'Sent' | 'Delivered' | 'Failed'

export interface SmsSendResult {
  providerMessageId: string
  state: SmsState
}

/** One part of a downloaded MMS as the device reported it. `data` is the decoded bytes, null when the device sent none or they did not decode. */
export interface MmsPart {
  partId: string | null
  /** Lower-cased media type without parameters ("image/jpeg"); "application/octet-stream" when the device gave none. */
  contentType: string
  name: string | null
  /** Bytes: the decoded length when the data decoded, else the size the device reported (null when it gave none). */
  size: number | null
  data: Buffer | null
  /** Why `data` is null: the device sent no data, or what it sent was not base64. */
  problem?: 'missing' | 'decode_failed'
  /** The decoded text of a text part (text/plain, or text/* with a charset), trimmed and capped; absent for other parts. */
  text?: string
}

/**
 * What an MMS adds to a received message. Its text is in `body`: the trimmed body, else the text of its text parts, else the
 * subject, else "".
 */
export interface MmsContent {
  subject: string | null
  parts: MmsPart[]
  /**
   * The device reported the MMS without what Oasis needs to act on it (no sender, or neither text nor a part with bytes: the
   * tablet's "MMS content incomplete"). Its provider id then ends in MMS_INCOMPLETE_SUFFIX, so the complete delivery of the
   * same message that may follow is not taken for a repeat of it (ADR 0151).
   */
  incomplete: boolean
}

/** Appended to the provider id of an incomplete MMS delivery (see MmsContent.incomplete). */
export const MMS_INCOMPLETE_SUFFIX = ':incomplete'

export type SmsEvent =
  | {
      kind: 'received'
      eventId: string
      from: string
      body: string
      at: Date
      deviceId: string
      providerMessageId: string
      /** Present for a downloaded MMS (mms:downloaded); absent for a plain SMS. */
      mms?: MmsContent
    }
  /** An MMS arrived (WAP push) but is not downloaded yet: recorded, never routed (its text is not known). */
  | {
      kind: 'mms_notified'
      eventId: string
      deviceId: string
      providerMessageId: string
      from: string | null
      at: Date
    }
  | {
      kind: 'sent' | 'delivered' | 'failed' | 'cancelled'
      eventId: string
      providerMessageId: string
      at: Date
      reason?: string
    }
  | { kind: 'ping' | 'app_started'; eventId: string; deviceId: string; at: Date }

export interface SmsDeviceHealth {
  ok: boolean
  battery?: number
  details?: unknown
}

export interface SmsProvider {
  send(req: SmsSendRequest): Promise<SmsSendResult>
  /** Look a message up by our id; null when the device has never seen it (safe to re-send). */
  status(id: string): Promise<{ state: SmsState; reason?: string } | null>
  health(): Promise<SmsDeviceHealth>
  registerWebhooks(urlBase: string, secret: string): Promise<void>
  /** Verifies the HMAC signature + timestamp tolerance and parses the event; throws on failure. */
  verifyAndParseWebhook(headers: Record<string, string | undefined>, rawBody: string): SmsEvent
}
