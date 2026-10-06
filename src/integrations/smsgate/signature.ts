import { createHmac, timingSafeEqual } from 'node:crypto'

// SMS Gate signs every webhook: X-Signature = hex(HMAC-SHA256(key, rawBody + X-Timestamp)), where X-Timestamp is the
// decimal Unix time in seconds and rawBody is the exact JSON text the device posted (not re-serialised).
// Source: SendWebhookWorker / PayloadSingingPlugin in the app (message = content.text + timestamp) and the webhooks docs.

export function signWebhook(secret: string, rawBody: string, timestamp: string | number): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').update(String(timestamp), 'utf8').digest('hex')
}

/** Constant-time comparison. Never throws; a malformed signature is simply false. */
export function verifySignature(secret: string, rawBody: string, timestamp: string, signature: string): boolean {
  const expected = Buffer.from(signWebhook(secret, rawBody, timestamp), 'hex')
  const presented = signature.trim().toLowerCase()
  const candidate = /^[0-9a-f]{64}$/.test(presented) ? Buffer.from(presented, 'hex') : Buffer.alloc(expected.length)
  const equal = timingSafeEqual(expected, candidate)
  return equal && /^[0-9a-f]{64}$/.test(presented)
}
