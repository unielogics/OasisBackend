// Cacheable public reads take their query string in exactly one spelling (review 2026-10-10). nginx caches those answers per URL,
// and the API decodes and coerces a query before validating it: an unknown parameter, a repeated one, a percent-encoded name or
// value, "014" for 14, each made a new cache entry for the same answer, so a script could miss the cache on every request and make
// the API compute the board each time. A route lists the parameters it takes and the raw characters each value may use; anything
// else is a 422 before validation (and the zod schema, strict, checks the decoded values as usual).
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../platform/errors.js'

/** Per parameter: the raw (undecoded) value must match this pattern. */
export type CanonicalQuerySpec = Readonly<Record<string, RegExp>>

const refuse = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

/** Throws 422 unless the raw query uses only the listed names, each at most once, with values of their raw pattern. */
export function assertCanonicalQuery(url: string, spec: CanonicalQuerySpec): void {
  const i = url.indexOf('?')
  if (i < 0) return
  const seen = new Set<string>()
  for (const part of url.slice(i + 1).split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const name = eq < 0 ? part : part.slice(0, eq)
    const value = eq < 0 ? '' : part.slice(eq + 1)
    const pattern = Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : undefined
    if (!pattern) throw refuse('query', `Unknown query parameter "${name.slice(0, 40)}".`)
    if (seen.has(name)) throw refuse(`query.${name}`, `Send ${name} once.`)
    seen.add(name)
    if (!pattern.test(value)) throw refuse(`query.${name}`, `Write ${name} as the website does.`)
  }
}

/** A preValidation hook for a route whose query must be canonical (an empty spec: no query at all). */
export function canonicalQuery(spec: CanonicalQuerySpec) {
  return (req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void): void => {
    try {
      assertCanonicalQuery(req.url, spec)
      done()
    } catch (e) {
      done(e as Error)
    }
  }
}
