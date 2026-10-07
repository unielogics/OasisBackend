// Adversarial review (rv/sec): credentials sealed with AES-256-GCM. The two SecretBox implementations (device credentials in the
// messaging module, the Squarespace key in payments-sync) must refuse anything but an intact, full-length authentication tag.
import { describe, expect, it } from 'vitest'
import { createSecretBox as messagingBox } from '../../src/modules/messaging/crypto.js'
import { createSecretBox as syncBox } from '../../src/modules/payments-sync/db/secrets.js'

const KEY = Buffer.alloc(32, 3).toString('base64')
const OTHER = Buffer.alloc(32, 4).toString('base64')

interface Box {
  encrypt(p: string): string
  decrypt(s: string): string
}

const boxes: Array<{ name: string; make: (key: string) => Box; sep: string; tagAt: number }> = [
  { name: 'messaging (v1.iv.tag.ct)', make: (k) => messagingBox(k, 'production'), sep: '.', tagAt: 2 },
  { name: 'payments-sync (keyId:iv:tag:ct)', make: (k) => syncBox([k]), sep: ':', tagAt: 2 },
]

describe.each(boxes)('SEC-13 secrets at rest: $name', ({ make, sep, tagAt }) => {
  it('round-trips and never repeats an IV', () => {
    const box = make(KEY)
    const sealed = new Set(Array.from({ length: 2000 }, () => box.encrypt('device-password')))
    expect(sealed.size).toBe(2000)
    expect(box.decrypt([...sealed][0]!)).toBe('device-password')
  })

  it('rejects a tampered ciphertext and a different key', () => {
    const sealed = make(KEY).encrypt('device-password')
    const parts = sealed.split(sep)
    const last = parts.length - 1
    parts[last] = Buffer.from('forged-content').toString('base64url')
    expect(() => make(KEY).decrypt(parts.join(sep))).toThrow()
    expect(() => make(OTHER).decrypt(sealed)).toThrow()
  })

  it('rejects a shortened authentication tag (a 4-byte tag is a 2^32 guess, not a proof)', () => {
    const sealed = make(KEY).encrypt('device-password')
    const parts = sealed.split(sep)
    parts[tagAt] = Buffer.from(parts[tagAt]!, 'base64url').subarray(0, 4).toString('base64url')
    expect(() => make(KEY).decrypt(parts.join(sep))).toThrow()
  })
})
