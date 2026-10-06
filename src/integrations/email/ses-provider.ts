import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2'
import type { EmailProvider, EmailRequest } from '../ports/email.js'
import { EmailError } from './errors.js'
import { assertAddress, formatAddress } from './mime.js'
import { renderTemplate } from './templates.js'

export interface SesProviderOptions {
  client: Pick<SESv2Client, 'send'>
  from: string
  fromName?: string
  replyTo?: string
  /** SES configuration set; needed for event publishing and to attach the sending-rate dashboards. */
  configurationSet?: string
}

const RETRYABLE_NAMES = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'InternalServiceErrorException',
  'ServiceUnavailable',
  'ThrottlingException',
  'RequestTimeout',
  'TimeoutError',
])
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])

export function classifySesError(err: unknown): EmailError {
  const e = err as {
    name?: string
    message?: string
    code?: string
    $retryable?: unknown
    $metadata?: { httpStatusCode?: number }
  }
  const status = e.$metadata?.httpStatusCode
  const retryable =
    RETRYABLE_NAMES.has(e.name ?? '') ||
    !!e.$retryable ||
    (status !== undefined && status >= 500) ||
    NETWORK_CODES.has(e.code ?? '')
  const detail = `${e.name ?? 'Error'}: ${e.message ?? 'unknown failure'}`
  return new EmailError(
    retryable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED',
    `SES SendEmail failed (${detail})`,
    {
      retryable,
      cause: err,
    },
  )
}

export class SesProvider implements EmailProvider {
  private readonly from: string

  constructor(private readonly opts: SesProviderOptions) {
    this.from = formatAddress(assertAddress(opts.from, 'SES_FROM_ADDRESS'), opts.fromName)
    if (opts.replyTo) assertAddress(opts.replyTo, 'replyTo')
  }

  async send(req: EmailRequest): Promise<{ id: string }> {
    assertAddress(req.to, 'to')
    if (req.replyTo) assertAddress(req.replyTo, 'replyTo')
    const rendered = renderTemplate(req)
    const replyTo = req.replyTo ?? this.opts.replyTo
    const cmd = new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [req.to] },
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: rendered.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: rendered.text, Charset: 'UTF-8' },
            Html: { Data: rendered.html, Charset: 'UTF-8' },
          },
        },
      },
      EmailTags: [{ Name: 'template', Value: req.template }],
      ...(this.opts.configurationSet ? { ConfigurationSetName: this.opts.configurationSet } : {}),
    })
    let out
    try {
      out = await this.opts.client.send(cmd)
    } catch (err) {
      throw classifySesError(err)
    }
    if (!out.MessageId)
      throw new EmailError('PROVIDER_REJECTED', 'SES accepted the request but returned no MessageId')
    return { id: out.MessageId }
  }
}
