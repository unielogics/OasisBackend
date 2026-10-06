import { describe, expect, it } from 'vitest'
import {
  AppError,
  appError,
  isAppError,
  problemDef,
  problemFromError,
  registerProblems,
  registeredProblemCodes,
} from '../../src/platform/errors.js'

describe('problem catalog', () => {
  it('uses the design toast strings as title and detail', () => {
    const e = new AppError('SLOT_UNAVAILABLE')
    expect(e.status).toBe(409)
    expect(e.title).toBe('Slot unavailable')
    expect(e.detail).toBe('Would overbook a bay — override required')
  })

  it('interpolates placeholders from params', () => {
    const e = new AppError('BAY_BUSY', { params: { n: 2, firstName: 'Liam' } })
    expect(e.title).toBe('Bay 2 is busy')
    expect(e.detail).toBe("Finish Liam's vehicle first")
    expect(new AppError('SLOT_VIP_HELD', { params: { release: 48 } }).detail).toBe(
      'Releases to everyone 48h before · VIP clients can book it now',
    )
  })

  it('leaves unresolved placeholders visible rather than hiding the bug', () => {
    expect(new AppError('BAY_BUSY').title).toBe('Bay {n} is busy')
  })

  it('renders RFC 9457 bodies', () => {
    const e = new AppError('VALIDATION_FAILED', {
      errors: [{ path: 'body.name', message: 'Required' }],
      meta: { a: 1 },
    })
    expect(problemFromError(e, 'req-1')).toEqual({
      type: 'urn:oasis:problem:validation-failed',
      title: 'Check the form',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'Some fields need attention',
      errors: [{ path: 'body.name', message: 'Required' }],
      requestId: 'req-1',
      meta: { a: 1 },
    })
  })

  it('maps the documented statuses', () => {
    const status = (c: string): number => new AppError(c).status
    expect(status('MALFORMED_REQUEST')).toBe(400)
    expect(status('UNAUTHENTICATED')).toBe(401)
    expect(status('FORBIDDEN')).toBe(403)
    expect(status('NOT_FOUND')).toBe(404)
    expect(status('STALE_STATE')).toBe(409)
    expect(status('VERSION_CONFLICT')).toBe(412)
    expect(status('VALIDATION_FAILED')).toBe(422)
    expect(status('IDEMPOTENCY_MISMATCH')).toBe(422)
    expect(status('IDEMPOTENCY_IN_FLIGHT')).toBe(409)
    expect(status('RATE_LIMITED')).toBe(429)
  })

  it('refuses unknown codes and conflicting re-registration, and accepts identical re-registration', () => {
    expect(() => new AppError('NOPE_NOT_REGISTERED')).toThrow(/Unregistered/)
    expect(() => registerProblems({ bad_code: { status: 400, title: 'x', detail: 'y' } })).toThrow(
      /Invalid problem code/,
    )
    registerProblems({ TEST_ONLY_CODE: { status: 418, title: 'Teapot', detail: 'Short and stout' } })
    registerProblems({ TEST_ONLY_CODE: { status: 418, title: 'Teapot', detail: 'Short and stout' } })
    expect(() =>
      registerProblems({ TEST_ONLY_CODE: { status: 418, title: 'Other', detail: 'Short and stout' } }),
    ).toThrow(/already registered/)
    expect(problemDef('TEST_ONLY_CODE')?.status).toBe(418)
    expect(registeredProblemCodes()).toContain('TEST_ONLY_CODE')
  })

  it('appError/isAppError helpers and explicit overrides', () => {
    const e = appError('FORBIDDEN', { detail: 'Only a Super Admin can do that' })
    expect(isAppError(e)).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
    expect(e.detail).toBe('Only a Super Admin can do that')
    expect(e.title).toBe('Not allowed')
  })
})
