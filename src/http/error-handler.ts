import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod'
import {
  AppError,
  PROBLEM_CONTENT_TYPE,
  isAppError,
  problemFromError,
  registerProblems,
  type ProblemField,
} from '../platform/errors.js'
import type { AppInstance } from './types.js'

registerProblems({
  METHOD_NOT_ALLOWED: { status: 405, title: 'Not allowed', detail: 'That method is not supported here' },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: 'Unsupported content type',
    detail: 'Send the request body as JSON',
  },
})

const SQLSTATE_RETRYABLE = new Set(['40001', '40P01'])

function pathOf(context: string | undefined, instancePath: string): string {
  const parts = instancePath.split('/').filter(Boolean)
  const tail = parts.reduce((acc, p) => (/^\d+$/.test(p) ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), '')
  const root = context === 'querystring' ? 'query' : (context ?? 'body')
  return tail ? `${root}.${tail}` : root
}

/** pg-pool's "no connection within connectionTimeoutMillis" and pg's "the connection did not open in time". */
const isPoolCheckoutTimeout = (err: unknown): boolean =>
  err instanceof Error &&
  (err.message === 'timeout exceeded when trying to connect' || err.message === 'Connection terminated due to connection timeout')

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err
  if (hasZodFastifySchemaValidationErrors(err)) {
    const errors: ProblemField[] = err.validation.map((v) => ({
      path: pathOf(err.validationContext, v.instancePath),
      message: v.message ?? 'Invalid value',
    }))
    return new AppError('VALIDATION_FAILED', { errors, detail: errors[0]?.message, cause: err })
  }
  if (isResponseSerializationError(err)) return new AppError('INTERNAL', { cause: err })

  const e = err as Partial<FastifyError> & { code?: string }
  if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return new AppError('PAYLOAD_TOO_LARGE', { cause: err })
  if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
    return new AppError('UNSUPPORTED_MEDIA_TYPE', { cause: err })
  if (e.code?.startsWith('FST_ERR_CTP_') || e.code === 'FST_ERR_VALIDATION')
    return new AppError('MALFORMED_REQUEST', { cause: err })
  if (e.statusCode === 429) return new AppError('RATE_LIMITED', { cause: err })
  if (e.statusCode === 404) return new AppError('NOT_FOUND', { cause: err })
  if (e.statusCode === 405) return new AppError('METHOD_NOT_ALLOWED', { cause: err })
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)
    return new AppError('MALFORMED_REQUEST', { cause: err })
  if (typeof e.code === 'string' && SQLSTATE_RETRYABLE.has(e.code))
    return new AppError('CONCURRENT_UPDATE', { cause: err })
  if (e.code === '57014' || isPoolCheckoutTimeout(err))
    return new AppError('SERVICE_UNAVAILABLE', { cause: err, headers: { 'Retry-After': '2' } })
  return new AppError('INTERNAL', { cause: err })
}

export function installErrorHandling(app: AppInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const e = toAppError(err)
    if (e.status >= 500) req.log.error({ err: e.cause ?? err, code: e.code }, 'request failed')
    const retry = (err as { headers?: Record<string, string> } | undefined)?.headers?.['retry-after']
    const headers = { ...e.headers, ...(retry ? { 'Retry-After': retry } : {}) }
    void reply.status(e.status).headers(headers).type(PROBLEM_CONTENT_TYPE).send(problemFromError(e, req.id))
  })

  app.setNotFoundHandler((req, reply) => {
    void reply
      .status(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(
        problemFromError(
          new AppError('ROUTE_NOT_FOUND', {
            meta: { method: req.method, path: req.url.split('?')[0] ?? '' },
          }),
          req.id,
        ),
      )
  })
}
