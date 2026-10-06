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

export type SmsEvent =
  | {
      kind: 'received'
      eventId: string
      from: string
      body: string
      at: Date
      deviceId: string
      providerMessageId: string
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
