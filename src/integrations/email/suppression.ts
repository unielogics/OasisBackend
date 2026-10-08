import type { EmailProvider, EmailRequest } from '../ports/email.js'
import { EmailError } from './errors.js'
import { normalizeAddress } from './mime.js'

/**
 * Whether an address is on the suppression list (hard bounces, complaints). `true` or a string means suppressed; the string
 * says why and becomes the error message recorded on the queued email.
 */
export type IsSuppressed = (address: string) => Promise<boolean | string> | boolean | string

export const SUPPRESSED_MESSAGE = 'recipient address is suppressed after a bounce or complaint'

/** Refuses to send to addresses on the suppression list before touching the provider. */
export function withSuppression(inner: EmailProvider, isSuppressed: IsSuppressed): EmailProvider {
  return {
    async send(req: EmailRequest) {
      const verdict = await isSuppressed(normalizeAddress(req.to))
      if (verdict) throw new EmailError('SUPPRESSED', typeof verdict === 'string' ? verdict : SUPPRESSED_MESSAGE)
      return inner.send(req)
    },
  }
}
