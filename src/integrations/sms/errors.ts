// Errors raised by SMS providers. The dispatcher only needs to know whether a retry is safe.
export type SmsProviderErrorKind =
  | 'rejected' // the device refused the request (4xx): retrying the same request cannot succeed
  | 'auth' // credentials rejected
  | 'transient' // network error, timeout or 5xx where the outcome is unknown or the device is unavailable
  | 'protocol' // an unexpected or unparseable response

export class SmsProviderError extends Error {
  readonly kind: SmsProviderErrorKind
  readonly status?: number
  readonly retryable: boolean

  constructor(kind: SmsProviderErrorKind, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'SmsProviderError'
    this.kind = kind
    this.status = opts.status
    this.retryable = kind === 'transient'
  }
}

export type WebhookErrorCode =
  | 'missing_header'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'bad_body'
  | 'unsupported_event'

export class SmsWebhookError extends Error {
  readonly code: WebhookErrorCode

  constructor(code: WebhookErrorCode, message: string) {
    super(message)
    this.name = 'SmsWebhookError'
    this.code = code
  }
}
