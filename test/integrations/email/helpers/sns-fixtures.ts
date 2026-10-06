import { execFileSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildStringToSign, type SnsEnvelope } from '../../../../src/integrations/email/sns.js'

export interface TestCert {
  certPem: string
  keyPem: string
}

/** Self-signed RSA certificate generated with the openssl CLI; nothing is committed and nothing leaves the box. */
export function generateTestCert(cn = 'sns.amazonaws.com', days = 30): TestCert {
  const dir = mkdtempSync(path.join(tmpdir(), 'oasis-sns-'))
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        String(days),
        '-subj',
        `/CN=${cn}`,
        '-keyout',
        path.join(dir, 'k.pem'),
        '-out',
        path.join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    )
    return {
      certPem: readFileSync(path.join(dir, 'c.pem'), 'utf8'),
      keyPem: readFileSync(path.join(dir, 'k.pem'), 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const TOPIC = 'arn:aws:sns:us-east-1:123456789012:oasis-ses-feedback'
export const CERT_URL =
  'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000000000000000000000abcd.pem'

export function signedEnvelope(
  cert: TestCert,
  over: Partial<SnsEnvelope> & { Type?: SnsEnvelope['Type'] } = {},
): SnsEnvelope {
  const base: SnsEnvelope = {
    Type: 'Notification',
    MessageId: '4d4dc071-ddbf-465d-bba8-08f81c89da64',
    TopicArn: TOPIC,
    Message: '{"hello":"world"}',
    Timestamp: '2026-10-06T12:00:00.000Z',
    SignatureVersion: '2',
    Signature: '',
    SigningCertURL: CERT_URL,
    ...over,
  }
  const signer = createSign(base.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256')
  signer.update(buildStringToSign(base), 'utf8')
  return { ...base, Signature: over.Signature ?? signer.sign(cert.keyPem, 'base64') }
}

export function sesNotification(
  kind: 'bounce' | 'complaint' | 'delivery',
  recipient = 'jane@example.com',
): string {
  const mail = {
    timestamp: '2026-10-06T11:59:00.000Z',
    messageId: '0100019aaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000000',
    source: 'no-reply@oasisautospa.example',
    destination: [recipient],
  }
  if (kind === 'bounce') {
    return JSON.stringify({
      notificationType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          {
            emailAddress: recipient,
            status: '5.1.1',
            action: 'failed',
            diagnosticCode: 'smtp; 550 user unknown',
          },
        ],
        timestamp: '2026-10-06T12:00:00.000Z',
        feedbackId: 'fb-1',
      },
    })
  }
  if (kind === 'complaint') {
    return JSON.stringify({
      notificationType: 'Complaint',
      mail,
      complaint: {
        complainedRecipients: [{ emailAddress: recipient }],
        complaintFeedbackType: 'abuse',
        timestamp: '2026-10-06T12:00:00.000Z',
        feedbackId: 'fb-2',
      },
    })
  }
  return JSON.stringify({
    notificationType: 'Delivery',
    mail,
    delivery: { timestamp: '2026-10-06T12:00:00.000Z', recipients: [recipient], smtpResponse: '250 ok' },
  })
}
