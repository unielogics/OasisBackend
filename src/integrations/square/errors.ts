/**
 * Square's error envelope, `{errors: [{category, code, detail, field}]}`, turned into typed errors (ADR 0171). Nothing here ever
 * carries the access token: messages name the method, the path and Square's codes only.
 */
export interface SquareErrorItem {
  category?: string
  code?: string
  detail?: string
  field?: string
}

export class SquareError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export class SquareApiError extends SquareError {
  constructor(
    readonly status: number,
    readonly errors: SquareErrorItem[],
    readonly method: string,
    readonly path: string,
    /** The object Square sent with the error, when it sent one (a declined payment carries its payment). */
    readonly body?: unknown,
  ) {
    const first = errors[0]
    super(
      `Square ${method} ${path} -> ${status}${first?.code ? ` ${first.code}` : ''}${first?.detail ? `: ${first.detail}` : ''}`,
    )
  }

  get code(): string | undefined {
    return this.errors[0]?.code
  }

  get category(): string | undefined {
    return this.errors[0]?.category
  }

  hasCode(...codes: string[]): boolean {
    return this.errors.some((e) => !!e.code && codes.includes(e.code))
  }

  /** 429 and 5xx: worth repeating for a call that may be repeated. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

/** 401 or an ACCESS_TOKEN_* code: the token is wrong, expired or revoked. Raises the integration's error state; never retried. */
export class SquareAuthError extends SquareApiError {}

/** 403 INSUFFICIENT_SCOPES and friends: the token works but may not do this. */
export class SquarePermissionError extends SquareApiError {}

/** A card or payment method was declined (PAYMENT_METHOD_ERROR). `friendly` is the text a client may read. */
export class SquareDeclined extends SquareApiError {
  get friendly(): string {
    return declineText(this.code)
  }
}

/** The same idempotency key was sent with a different body: a bug on our side, never retried. */
export class SquareIdempotencyReused extends SquareApiError {}

export class SquareRateLimited extends SquareApiError {}

export class SquareNotFound extends SquareApiError {}

/** The request never produced an HTTP answer (DNS, refused, reset, timeout). `sent` is false when it surely never left. */
export class SquareNetworkError extends SquareError {
  constructor(
    message: string,
    readonly sent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** A 2xx body that does not have the shape the wire schema expects. */
export class SquareWireError extends SquareError {}

/** A call that would change something at Square while SQUARE_WRITES_ENABLED=false (observe-only). */
export class SquareWritesDisabled extends SquareError {
  constructor(what: string) {
    super(`Square writes are off (SQUARE_WRITES_ENABLED=false): ${what} was not sent`)
  }
}

/** Codes that mean the token itself is the problem. */
const AUTH_CODES = ['UNAUTHORIZED', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_REVOKED', 'INVALID_ACCESS_TOKEN']

export function squareErrorFrom(
  status: number,
  body: unknown,
  method: string,
  path: string,
): SquareApiError {
  const errors = errorItems(body)
  const codes = errors.map((e) => e.code ?? '')
  const categories = errors.map((e) => e.category ?? '')
  const rest = stripErrors(body)
  if (status === 401 || codes.some((c) => AUTH_CODES.includes(c)))
    return new SquareAuthError(status, errors, method, path, rest)
  if (status === 429 || codes.includes('RATE_LIMITED')) return new SquareRateLimited(status, errors, method, path, rest)
  if (codes.includes('IDEMPOTENCY_KEY_REUSED')) return new SquareIdempotencyReused(status, errors, method, path, rest)
  if (categories.includes('PAYMENT_METHOD_ERROR')) return new SquareDeclined(status, errors, method, path, rest)
  if (status === 403) return new SquarePermissionError(status, errors, method, path, rest)
  if (status === 404 || codes.includes('NOT_FOUND')) return new SquareNotFound(status, errors, method, path, rest)
  return new SquareApiError(status, errors, method, path, rest)
}

function errorItems(body: unknown): SquareErrorItem[] {
  const list = (body as { errors?: unknown } | null)?.errors
  if (!Array.isArray(list)) return []
  return list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      ...(typeof e.category === 'string' ? { category: e.category } : {}),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.detail === 'string' ? { detail: e.detail.slice(0, 500) } : {}),
      ...(typeof e.field === 'string' ? { field: e.field } : {}),
    }))
}

function stripErrors(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'errors'))
  return Object.keys(rest).length ? rest : undefined
}

/** What a client may read when a card is declined: plain, friendly, never Square's internal detail. */
const DECLINE_TEXT: Record<string, string> = {
  GENERIC_DECLINE: 'Your card was declined. Please try another card.',
  CARD_DECLINED: 'Your card was declined. Please try another card.',
  CVV_FAILURE: 'The security code did not match. Please check it and try again.',
  ADDRESS_VERIFICATION_FAILURE: 'The ZIP code did not match the card. Please check it and try again.',
  INVALID_POSTAL_CODE: 'The ZIP code did not match the card. Please check it and try again.',
  INVALID_EXPIRATION: 'The expiration date is not right. Please check it and try again.',
  CARD_EXPIRED: 'This card has expired. Please use another card.',
  INSUFFICIENT_FUNDS: 'The card was declined for insufficient funds. Please try another card.',
  INVALID_CARD: 'This card number is not valid. Please check it and try again.',
  INVALID_CARD_DATA: 'This card number is not valid. Please check it and try again.',
  CARD_NOT_SUPPORTED: 'This card is not supported. Please use another card.',
  CARD_DECLINED_VERIFICATION_REQUIRED: 'Your bank needs to verify this card. Please try again and follow its steps.',
  CARD_DECLINED_CALL_ISSUER: 'Your card was declined. Please call your bank or use another card.',
  TRANSACTION_LIMIT: 'This amount is over the card limit. Please try another card.',
  VOICE_FAILURE: 'Your card was declined. Please call your bank or use another card.',
  PAN_FAILURE: 'This card number is not valid. Please check it and try again.',
  EXPIRATION_FAILURE: 'The expiration date is not right. Please check it and try again.',
  CARD_TOKEN_EXPIRED: 'The card form timed out. Please enter the card again.',
  CARD_TOKEN_USED: 'The card form was already used. Please enter the card again.',
}

export function declineText(code: string | undefined): string {
  return (code && DECLINE_TEXT[code]) || 'The payment did not go through. Please try another card.'
}
