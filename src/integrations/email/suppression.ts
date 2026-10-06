import type { EmailProvider, EmailRequest } from '../ports/email.js'
import { EmailError } from './errors.js'
import { normalizeAddress } from './mime.js'

export type IsSuppressed = (address: string) => Promise<boolean> | boolean

/** Refuses to send to addresses on the suppression list (hard bounces, complaints) before touching the provider. */
export function withSuppression(inner: EmailProvider, isSuppressed: IsSuppressed): EmailProvider {
  return {
    async send(req: EmailRequest) {
      if (await isSuppressed(normalizeAddress(req.to))) {
        throw new EmailError('SUPPRESSED', 'recipient address is suppressed after a bounce or complaint')
      }
      return inner.send(req)
    },
  }
}
