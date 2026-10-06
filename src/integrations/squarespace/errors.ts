/** Squarespace standard error object (docs: responses-error-handling). Every field may be null. */
export interface SquarespaceErrorBody {
  type?: string | null
  subtype?: string | null
  message?: string | null
  details?: unknown
  contextId?: string | null
}

export class SquarespaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export class SquarespaceApiError extends SquarespaceError {
  constructor(
    readonly status: number,
    readonly body: SquarespaceErrorBody | undefined,
    readonly method: string,
    readonly path: string,
  ) {
    super(
      `Squarespace ${method} ${path} -> ${status}${body?.type ? ` ${body.type}` : ''}${
        body?.message ? `: ${body.message}` : ''
      }${body?.contextId ? ` (contextId ${body.contextId})` : ''}`,
    )
  }

  /** 5xx, or a transient network fault: worth retrying with backoff. */
  get retryable(): boolean {
    return this.status >= 500
  }
}

/** 401: bad, revoked or expired credential. Never retried blindly. */
export class SquarespaceAuthError extends SquarespaceApiError {}

/** 402: the website that owns the token is expired (documented). 403: insufficient permission/plan. */
export class SquarespacePermissionError extends SquarespaceApiError {}

export class SquarespaceNotFoundError extends SquarespaceApiError {}

export class SquarespaceRateLimitError extends SquarespaceApiError {
  constructor(
    body: SquarespaceErrorBody | undefined,
    method: string,
    path: string,
    readonly retryAfterMs: number,
  ) {
    super(429, body, method, path)
  }
}

/** The request never produced an HTTP response (DNS, TLS, reset, timeout). */
export class SquarespaceNetworkError extends SquarespaceError {}

/** A 2xx body that does not match the documented shape. */
export class SquarespaceMappingError extends SquarespaceError {}
