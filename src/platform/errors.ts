// RFC 9457 problem+json model. `code` is machine readable; for guard failures `title` and `detail` are exactly the
// design's toast strings so the dashboard can show them unchanged. Verticals add their own codes with registerProblems().
export interface ProblemField {
  path: string
  message: string
}

export interface ProblemBody {
  type: string
  title: string
  status: number
  code: string
  detail: string
  errors?: ProblemField[]
  requestId?: string
  meta?: Record<string, unknown>
}

export interface ProblemDef {
  status: number
  title: string
  detail: string
}

const catalog = new Map<string, ProblemDef>()

export function registerProblems(defs: Record<string, ProblemDef>): void {
  for (const [code, def] of Object.entries(defs)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new Error(`Invalid problem code: ${code}`)
    const existing = catalog.get(code)
    if (existing && JSON.stringify(existing) !== JSON.stringify(def)) {
      throw new Error(`Problem code ${code} is already registered with different copy`)
    }
    catalog.set(code, def)
  }
}

export const problemDef = (code: string): ProblemDef | undefined => catalog.get(code)
export const registeredProblemCodes = (): string[] => [...catalog.keys()].sort()

registerProblems({
  MALFORMED_REQUEST: { status: 400, title: 'Malformed request', detail: 'The request could not be read' },
  INVALID_CURSOR: {
    status: 400,
    title: 'Invalid cursor',
    detail: 'The page cursor is not valid; reload the list',
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    title: 'Idempotency key required',
    detail: 'Send an Idempotency-Key header with this request',
  },
  IDEMPOTENCY_KEY_INVALID: {
    status: 400,
    title: 'Invalid idempotency key',
    detail: 'Idempotency-Key must be 8 to 128 characters: letters, digits, dot, dash, underscore or colon',
  },
  UNAUTHENTICATED: {
    status: 401,
    title: 'Sign in required',
    detail: 'Your session has expired. Sign in again',
  },
  FORBIDDEN: { status: 403, title: 'Not allowed', detail: "You don't have permission to do that" },
  ORIGIN_NOT_ALLOWED: { status: 403, title: 'Request blocked', detail: 'The request origin is not allowed' },
  NOT_FOUND: { status: 404, title: 'Not found', detail: 'That record does not exist' },
  ROUTE_NOT_FOUND: { status: 404, title: 'Not found', detail: 'No such endpoint' },
  STALE_STATE: {
    status: 409,
    title: 'Out of date',
    detail: 'This changed while you were looking. Refresh and try again',
  },
  IDEMPOTENCY_IN_FLIGHT: {
    status: 409,
    title: 'Already in progress',
    detail: 'The same request is still being processed. Try again in a moment',
  },
  CONCURRENT_UPDATE: {
    status: 409,
    title: 'Busy, try again',
    detail: 'Another change was applied at the same moment. Try again',
  },
  BAY_BUSY: { status: 409, title: 'Bay {n} is busy', detail: "Finish {firstName}'s vehicle first" },
  NO_BAY_FREE: { status: 409, title: 'No bay free', detail: 'Every bay is occupied right now' },
  SLOT_UNAVAILABLE: {
    status: 409,
    title: 'Slot unavailable',
    detail: 'Would overbook a bay — override required',
  },
  SLOT_VIP_HELD: {
    status: 409,
    title: 'Held for VIP clients',
    detail: 'Releases to everyone {release}h before · VIP clients can book it now',
  },
  VERSION_CONFLICT: {
    status: 412,
    title: 'Edited elsewhere',
    detail: 'Someone else changed this. Reload to see the latest version',
  },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Request too large', detail: 'The request body is too large' },
  VALIDATION_FAILED: { status: 422, title: 'Check the form', detail: 'Some fields need attention' },
  IDEMPOTENCY_MISMATCH: {
    status: 422,
    title: 'Idempotency key reused',
    detail: 'That Idempotency-Key was already used with a different request',
  },
  RATE_LIMITED: { status: 429, title: 'Slow down', detail: 'Too many requests. Try again shortly' },
  INTERNAL: { status: 500, title: 'Something went wrong', detail: 'An unexpected error occurred' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Temporarily unavailable', detail: 'Try again in a moment' },
})

const interpolate = (tpl: string, params: Record<string, unknown> | undefined): string =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m))

export interface AppErrorOptions {
  /** Values for {placeholders} in the catalog title and detail. */
  params?: Record<string, unknown>
  title?: string
  detail?: string
  errors?: ProblemField[]
  meta?: Record<string, unknown>
  headers?: Record<string, string>
  cause?: unknown
}

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly title: string
  readonly detail: string
  readonly errors?: ProblemField[]
  readonly meta?: Record<string, unknown>
  readonly headers?: Record<string, string>

  constructor(code: string, opts: AppErrorOptions = {}) {
    const def = catalog.get(code)
    if (!def) throw new Error(`Unregistered problem code: ${code}`)
    const detail = opts.detail ?? interpolate(def.detail, opts.params)
    super(detail, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'AppError'
    this.code = code
    this.status = def.status
    this.title = opts.title ?? interpolate(def.title, opts.params)
    this.detail = detail
    if (opts.errors) this.errors = opts.errors
    if (opts.meta) this.meta = opts.meta
    if (opts.headers) this.headers = opts.headers
  }
}

export const appError = (code: string, opts?: AppErrorOptions): AppError => new AppError(code, opts)

export const isAppError = (e: unknown): e is AppError => e instanceof AppError

const toSlug = (code: string): string => code.toLowerCase().replace(/_/g, '-')

export function problemFromError(e: AppError, requestId?: string): ProblemBody {
  const body: ProblemBody = {
    type: `urn:oasis:problem:${toSlug(e.code)}`,
    title: e.title,
    status: e.status,
    code: e.code,
    detail: e.detail,
  }
  if (e.errors?.length) body.errors = e.errors
  if (requestId) body.requestId = requestId
  if (e.meta) body.meta = e.meta
  return body
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8'
