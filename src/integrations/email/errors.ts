export type EmailErrorCode =
  | 'UNKNOWN_TEMPLATE'
  | 'MISSING_VAR'
  | 'UNKNOWN_VAR'
  | 'INVALID_VAR'
  | 'INVALID_ADDRESS'
  | 'SUPPRESSED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNAVAILABLE'

export class EmailError extends Error {
  readonly code: EmailErrorCode
  /** True when the same request may succeed later (throttling, outage). Callers retry only these. */
  readonly retryable: boolean
  constructor(code: EmailErrorCode, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'EmailError'
    this.code = code
    this.retryable = opts.retryable ?? false
  }
}
