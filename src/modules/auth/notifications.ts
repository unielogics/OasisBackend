// How invite and password-reset links reach a person. The SMS (SMS Gate) and email (SES) wiring comes later; until then
// the in-memory implementation records messages, and callers learn that nothing was delivered.
export type AccountMessageKind = 'invite' | 'password_reset'

export interface AccountMessage {
  kind: AccountMessageKind
  employeeId: string
  firstName: string
  /** E.164 when known. */
  phone: string | null
  email: string | null
  /** Absolute dashboard URL carrying the one-time token. */
  link: string
  expiresAt: Date
}

export type DeliveryChannel = 'sms' | 'email' | 'memory' | 'none'

export interface DeliveryResult {
  delivered: boolean
  channel: DeliveryChannel
}

export interface NotificationPort {
  /** Sends the message by SMS, falling back to email. Never throws for an undeliverable address. */
  deliver(msg: AccountMessage): Promise<DeliveryResult>
}

/** Records messages for tests and local development; reports them as not delivered so callers do not rely on it. */
export class InMemoryNotifier implements NotificationPort {
  readonly sent: AccountMessage[] = []

  async deliver(msg: AccountMessage): Promise<DeliveryResult> {
    this.sent.push(msg)
    return { delivered: false, channel: 'memory' }
  }

  last(kind?: AccountMessageKind): AccountMessage | undefined {
    return [...this.sent].reverse().find((m) => !kind || m.kind === kind)
  }

  /** The one-time token carried by the most recent link. */
  lastToken(kind?: AccountMessageKind): string | undefined {
    const m = this.last(kind)
    return m ? (new URL(m.link).searchParams.get('token') ?? undefined) : undefined
  }

  clear(): void {
    this.sent.length = 0
  }
}

export const INVITE_PATH = '/invite'
export const RESET_PATH = '/reset-password'

export function accountLink(dashboardUrl: string, kind: AccountMessageKind, token: string): string {
  const u = new URL(kind === 'invite' ? INVITE_PATH : RESET_PATH, dashboardUrl)
  u.searchParams.set('token', token)
  return u.toString()
}
