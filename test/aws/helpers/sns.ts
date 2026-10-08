// A throwaway certificate authority and an SNS-like signing certificate, generated with the openssl CLI for each run (nothing is
// committed, nothing leaves the box), and helpers that sign SNS envelopes exactly as Amazon SNS does.
import { execFileSync } from 'node:child_process'
import { createSign, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildStringToSign, type SnsEnvelope } from '../../../src/integrations/email/sns.js'

export interface SigningCert {
  caPem: string
  certPem: string
  keyPem: string
}

/** A CA, and a leaf certificate for sns.amazonaws.com signed by it, valid from a minute ago for `days`. */
export function generateSigningCert(days = 30): SigningCert {
  const dir = mkdtempSync(path.join(tmpdir(), 'oasis-sns-ca-'))
  const f = (n: string): string => path.join(dir, n)
  const run = (args: string[]): void => void execFileSync('openssl', args, { stdio: 'ignore' })
  try {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(days), '-subj', '/CN=Oasis Test SNS CA', '-keyout', f('ca.key'), '-out', f('ca.pem')])
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=sns.amazonaws.com', '-keyout', f('leaf.key'), '-out', f('leaf.csr')])
    writeFileSync(f('ext.cnf'), 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n')
    run(['x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', String(days), '-sha256', '-extfile', f('ext.cnf'), '-out', f('leaf.pem')])
    return { caPem: readFileSync(f('ca.pem'), 'utf8'), certPem: readFileSync(f('leaf.pem'), 'utf8'), keyPem: readFileSync(f('leaf.key'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const REGION = 'us-east-1'
export const ACCOUNT = '123456789012'
export const TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:oasis-ses-events`
export const OTHER_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:someone-elses-topic`
export const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem`

export function sign(key: string, e: Omit<SnsEnvelope, 'Signature'> & { Signature?: string }): SnsEnvelope {
  const env = { ...e, Signature: '' } as SnsEnvelope
  const signer = createSign(env.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256')
  signer.update(buildStringToSign(env), 'utf8')
  return { ...env, Signature: signer.sign(key, 'base64') }
}

export function notification(
  cert: SigningCert,
  message: object | string,
  o: { at: Date; messageId?: string; topic?: string; version?: '1' | '2'; certUrl?: string; subject?: string },
): SnsEnvelope {
  return sign(cert.keyPem, {
    Type: 'Notification',
    MessageId: o.messageId ?? randomUUID(),
    TopicArn: o.topic ?? TOPIC,
    ...(o.subject ? { Subject: o.subject } : {}),
    Message: typeof message === 'string' ? message : JSON.stringify(message),
    Timestamp: o.at.toISOString(),
    SignatureVersion: o.version ?? '2',
    SigningCertURL: o.certUrl ?? CERT_URL,
  })
}

export function subscriptionConfirmation(cert: SigningCert, o: { at: Date; topic?: string; subscribeUrl?: string }): SnsEnvelope {
  const topic = o.topic ?? TOPIC
  const token = `token-${randomUUID()}`
  return sign(cert.keyPem, {
    Type: 'SubscriptionConfirmation',
    MessageId: randomUUID(),
    TopicArn: topic,
    Token: token,
    Message: `You have chosen to subscribe to the topic ${topic}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`,
    SubscribeURL:
      o.subscribeUrl ?? `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=${token}`,
    Timestamp: o.at.toISOString(),
    SignatureVersion: '1',
    SigningCertURL: CERT_URL,
  })
}

/** SES event-publishing JSON (configuration-set events name the type `eventType`). */
export function sesEvent(
  kind: 'Bounce' | 'Complaint' | 'Delivery' | 'Reject',
  o: { messageId: string; recipient: string; at: Date; bounceType?: 'Permanent' | 'Transient'; subType?: string },
): object {
  const mail = {
    timestamp: new Date(o.at.getTime() - 60_000).toISOString(),
    messageId: o.messageId,
    source: 'no-reply@oasisautospa.example',
    destination: [o.recipient],
  }
  if (kind === 'Bounce')
    return {
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: o.bounceType ?? 'Permanent',
        bounceSubType: o.subType ?? 'General',
        bouncedRecipients: [{ emailAddress: o.recipient, status: '5.1.1', action: 'failed', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }],
        timestamp: o.at.toISOString(),
        feedbackId: `fb-${randomUUID()}`,
      },
    }
  if (kind === 'Complaint')
    return {
      eventType: 'Complaint',
      mail,
      complaint: { complainedRecipients: [{ emailAddress: o.recipient }], complaintFeedbackType: 'abuse', timestamp: o.at.toISOString(), feedbackId: `fb-${randomUUID()}` },
    }
  if (kind === 'Delivery')
    return { eventType: 'Delivery', mail, delivery: { timestamp: o.at.toISOString(), recipients: [o.recipient], smtpResponse: '250 ok' } }
  return { eventType: 'Reject', mail, reject: { reason: 'Bad content' } }
}
