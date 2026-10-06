import { describe, expect, it } from 'vitest'
import { PasswordHasher, parseHash, passwordProblem } from '../../src/modules/auth/password.js'
import { csrfTokenFor, hashToken, newToken, TOKEN_SHAPE } from '../../src/modules/auth/tokens.js'

const cheap = { ln: 10, r: 8, p: 1 }

describe('password hashing', () => {
  it('stores a PHC-style scrypt string carrying its parameters, salted per hash', async () => {
    const h = new PasswordHasher(cheap)
    const a = await h.hash('correct horse battery')
    const b = await h.hash('correct horse battery')
    expect(a).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(a).not.toBe(b)
    expect(a).not.toContain('correct horse')
    expect(parseHash(a)).toMatchObject({ params: cheap })
  })

  it('verifies the right password only, from the parameters in the string (not the hasher defaults)', async () => {
    const stored = await new PasswordHasher(cheap).hash('correct horse battery')
    const other = new PasswordHasher({ ln: 11, r: 8, p: 1 })
    expect(await other.verify('correct horse battery', stored)).toBe(true)
    expect(await other.verify('correct horse batterz', stored)).toBe(false)
    expect(await other.verify('', stored)).toBe(false)
  })

  it('normalises Unicode so the same passphrase typed differently still matches', async () => {
    const h = new PasswordHasher(cheap)
    const stored = await h.hash('café passphrase!')
    expect(await h.verify('café passphrase!', stored)).toBe(true)
  })

  it('flags other algorithms and other costs for rehash, and rejects malformed or oversized hashes', async () => {
    const h = new PasswordHasher(cheap)
    const stored = await h.hash('x'.repeat(12))
    expect(h.needsRehash(stored)).toBe(false)
    expect(new PasswordHasher({ ln: 12, r: 8, p: 1 }).needsRehash(stored)).toBe(true)
    expect(h.needsRehash('$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA')).toBe(true)
    for (const bad of [
      '',
      'plain',
      '$scrypt$',
      '$scrypt$ln=10,r=8,p=1$c2FsdA$',
      '$scrypt$ln=30,r=8,p=1$c29tZXNhbHRzYWx0$' + 'a'.repeat(40),
      '$scrypt$ln=10,r=8,p=1$c29tZXNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA$extra',
    ]) {
      expect(parseHash(bad)).toBeNull()
      expect(await h.verify('x'.repeat(12), bad)).toBe(false)
    }
  })

  it('defaults to the OWASP cost (N=2^15, r=8, p=3)', async () => {
    expect(new PasswordHasher().params).toEqual({ ln: 15, r: 8, p: 3 })
  })

  it('dummyVerify spends comparable work without a stored hash', async () => {
    await expect(new PasswordHasher(cheap).dummyVerify('anything at all')).resolves.toBeUndefined()
  })

  it('enforces length and rejects the email or a repeated character', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/)
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/)
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toMatch(/repetitive/)
    expect(passwordProblem('Amara@Example.test', { email: 'amara@example.test' })).toMatch(/email/)
    expect(passwordProblem('correct horse battery')).toBeNull()
  })
})

describe('tokens', () => {
  it('are 256-bit opaque and unique; only the sha256 is stored', () => {
    const a = newToken()
    expect(a).toMatch(TOKEN_SHAPE)
    expect(newToken()).not.toBe(a)
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(a)).not.toContain(a)
  })

  it('csrf tokens are bound to the session id and secret', () => {
    const t = csrfTokenFor('secret-a', 'session-1')
    expect(t).toBe(csrfTokenFor('secret-a', 'session-1'))
    expect(t).not.toBe(csrfTokenFor('secret-b', 'session-1'))
    expect(t).not.toBe(csrfTokenFor('secret-a', 'session-2'))
    expect(t).not.toContain('secret-a')
  })
})
