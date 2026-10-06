import { verify, X509Certificate } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../../platform/clock.js'

// SNS HTTP(S) message authentication, per
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
//  * SigningCertURL must be https on an sns.<region>.amazonaws.com(.cn) host and a .pem path
//  * the string to sign is "Name\nValue\n" for a fixed, byte-sorted field list (Subject only when present)
//  * SignatureVersion 1 = RSA-SHA1, 2 = RSA-SHA256, Signature is base64
//  * the TopicArn must be one we expect

export class SnsVerificationError extends Error {
  constructor(
    readonly code:
      | 'MALFORMED'
      | 'UNEXPECTED_TOPIC'
      | 'BAD_CERT_URL'
      | 'CERT_FETCH_FAILED'
      | 'BAD_CERT'
      | 'BAD_SIGNATURE'
      | 'BAD_SUBSCRIBE_URL'
      | 'STALE',
    message: string,
  ) {
    super(message)
    this.name = 'SnsVerificationError'
  }
}

const envelope = z
  .object({
    Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
    MessageId: z.string().min(1),
    TopicArn: z.string().min(1),
    Message: z.string(),
    Timestamp: z.string().min(1),
    Subject: z.string().optional(),
    SignatureVersion: z.enum(['1', '2']),
    Signature: z.string().min(1),
    SigningCertURL: z.string().min(1),
    SubscribeURL: z.string().optional(),
    Token: z.string().optional(),
  })
  .passthrough()

export type SnsEnvelope = z.infer<typeof envelope>

export function parseSnsEnvelope(body: string | unknown): SnsEnvelope {
  let obj: unknown = body
  if (typeof body === 'string') {
    try {
      obj = JSON.parse(body)
    } catch {
      throw new SnsVerificationError('MALFORMED', 'SNS body is not valid JSON')
    }
  }
  const r = envelope.safeParse(obj)
  if (!r.success) throw new SnsVerificationError('MALFORMED', 'SNS body is missing required fields')
  const e = r.data
  if (e.Type !== 'Notification' && (!e.SubscribeURL || !e.Token)) {
    throw new SnsVerificationError('MALFORMED', `${e.Type} requires SubscribeURL and Token`)
  }
  return e
}

const SNS_HOST = /^sns\.[a-z0-9-]{3,}\.amazonaws\.com(\.cn)?$/

/** https, a real SNS regional host, no credentials or custom port, and (for certificates) a .pem path. */
export function isSnsUrl(raw: string, opts: { pem?: boolean } = {}): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  if (!SNS_HOST.test(u.hostname)) return false
  return opts.pem ? u.pathname.toLowerCase().endsWith('.pem') : true
}

export function buildStringToSign(e: SnsEnvelope): string {
  const fields: Array<[string, string | undefined]> =
    e.Type === 'Notification'
      ? [
          ['Message', e.Message],
          ['MessageId', e.MessageId],
          ['Subject', e.Subject],
          ['Timestamp', e.Timestamp],
          ['TopicArn', e.TopicArn],
          ['Type', e.Type],
        ]
      : [
          ['Message', e.Message],
          ['MessageId', e.MessageId],
          ['SubscribeURL', e.SubscribeURL],
          ['Timestamp', e.Timestamp],
          ['Token', e.Token],
          ['TopicArn', e.TopicArn],
          ['Type', e.Type],
        ]
  return fields
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}\n${v}\n`)
    .join('')
}

export type CertFetcher = (url: string) => Promise<string>
export type UrlFetcher = (url: string) => Promise<{ ok: boolean; status: number }>

const MAX_CERT_BYTES = 64 * 1024

/** Default fetchers: global fetch, hard timeout, no redirects, bounded body. Inject fakes in tests. */
export const httpCertFetcher: CertFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_CERT_BYTES) throw new Error('certificate response too large')
  return text
}

export const httpUrlFetcher: UrlFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
  await res.arrayBuffer().catch(() => undefined)
  return { ok: res.ok, status: res.status }
}

export interface SnsVerifierOptions {
  clock: Clock
  fetchCertificate?: CertFetcher
  /** Only these topics are accepted. Empty means any topic: unsafe outside tests. */
  allowedTopicArns: readonly string[]
  /** Reject envelopes whose Timestamp is older than this (replay guard); omit to skip. */
  maxAgeSec?: number
}

export class SnsVerifier {
  private readonly certs = new Map<string, X509Certificate>()
  private readonly fetchCert: CertFetcher

  constructor(private readonly opts: SnsVerifierOptions) {
    this.fetchCert = opts.fetchCertificate ?? httpCertFetcher
  }

  checkTopic(e: SnsEnvelope): void {
    if (this.opts.allowedTopicArns.length > 0 && !this.opts.allowedTopicArns.includes(e.TopicArn)) {
      throw new SnsVerificationError('UNEXPECTED_TOPIC', 'message is from a topic this server does not trust')
    }
  }

  private async certificate(url: string): Promise<X509Certificate> {
    const cached = this.certs.get(url)
    if (cached) return cached
    let pem: string
    try {
      pem = await this.fetchCert(url)
    } catch (err) {
      throw new SnsVerificationError(
        'CERT_FETCH_FAILED',
        `could not fetch signing certificate: ${(err as Error).message}`,
      )
    }
    let cert: X509Certificate
    try {
      cert = new X509Certificate(pem)
    } catch {
      throw new SnsVerificationError('BAD_CERT', 'signing certificate is not valid PEM')
    }
    this.certs.set(url, cert)
    return cert
  }

  /** Throws SnsVerificationError unless the envelope is authentic (and recent, when maxAgeSec is set). */
  async verify(e: SnsEnvelope): Promise<void> {
    this.checkTopic(e)
    if (!isSnsUrl(e.SigningCertURL, { pem: true })) {
      throw new SnsVerificationError('BAD_CERT_URL', 'SigningCertURL is not an SNS certificate URL')
    }
    const cert = await this.certificate(e.SigningCertURL)
    const now = this.opts.clock.now().getTime()
    if (now < new Date(cert.validFrom).getTime() || now > new Date(cert.validTo).getTime()) {
      this.certs.delete(e.SigningCertURL)
      throw new SnsVerificationError('BAD_CERT', 'signing certificate is expired or not yet valid')
    }
    const key = cert.publicKey
    if (key.asymmetricKeyType !== 'rsa')
      throw new SnsVerificationError('BAD_CERT', 'signing certificate is not RSA')
    const algo = e.SignatureVersion === '2' ? 'sha256' : 'sha1'
    let ok = false
    try {
      ok = verify(algo, Buffer.from(buildStringToSign(e), 'utf8'), key, Buffer.from(e.Signature, 'base64'))
    } catch {
      ok = false
    }
    if (!ok) throw new SnsVerificationError('BAD_SIGNATURE', 'SNS signature does not match the message')
    if (this.opts.maxAgeSec !== undefined) {
      const sent = new Date(e.Timestamp).getTime()
      if (Number.isNaN(sent) || now - sent > this.opts.maxAgeSec * 1000) {
        throw new SnsVerificationError('STALE', 'SNS message is older than the accepted window')
      }
    }
  }
}
