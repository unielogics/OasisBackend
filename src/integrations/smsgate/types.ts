// Wire types for the SMS Gate (capcom6/android-sms-gateway) local server. Verified against the app source and the
// published OpenAPI document; see docs/integrations/smsgate.md for sources and what remains unverified on a real device.

export const SMSGATE_WEBHOOK_EVENTS = [
  'sms:received',
  'sms:sent',
  'sms:delivered',
  'sms:failed',
  'sms:cancelled',
  'system:ping',
  'app:started',
] as const

export type SmsGateWebhookEvent = (typeof SMSGATE_WEBHOOK_EVENTS)[number]

export type SmsGateProcessingState = 'Pending' | 'Cancelling' | 'Cancelled' | 'Processed' | 'Sent' | 'Delivered' | 'Failed'

export interface SmsGateRecipientState {
  phoneNumber: string
  state: SmsGateProcessingState
  error?: string
}

/** Response of POST /messages (202) and GET /messages/{id}. */
export interface SmsGateMessageState {
  id: string
  deviceId?: string
  state: SmsGateProcessingState
  recipients?: SmsGateRecipientState[]
  states?: Record<string, string>
  isHashed?: boolean
  isEncrypted?: boolean
  createdAt?: string
}

export interface SmsGateSendBody {
  id: string
  textMessage?: { text: string }
  message?: string
  phoneNumbers: string[]
  simNumber?: number
  withDeliveryReport: boolean
  ttl?: number
  priority?: number
}

export interface SmsGateWebhookRegistration {
  id: string
  url: string
  event: SmsGateWebhookEvent | string
  deviceId?: string | null
}

export interface SmsGateCheck {
  status: 'pass' | 'warn' | 'fail'
  observedValue?: number
  observedUnit?: string
  description?: string
}

export interface SmsGateHealthBody {
  status: 'pass' | 'warn' | 'fail'
  version?: string
  releaseId?: number
  checks?: Record<string, SmsGateCheck>
}

/** Envelope of every webhook delivery. `id` is unique per delivery and stable across retries of that delivery. */
export interface SmsGateWebhookEnvelope {
  deviceId: string
  event: string
  id: string
  webhookId?: string
  payload: Record<string, unknown>
}

/** What `details` carries on SmsDeviceHealth for this adapter. */
export interface SmsGateHealthDetails {
  reachable: boolean
  status: 'pass' | 'warn' | 'fail' | 'unreachable'
  httpStatus?: number
  version?: string
  checks?: Record<string, SmsGateCheck>
  charging?: boolean
  error?: string
}
