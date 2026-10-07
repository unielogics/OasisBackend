// Adversarial review (rv/sec): the SMS device address is a URL the server calls with the device's stored credentials.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { useHarness, type Harness, type Session } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

interface Canary {
  url: string
  hits: Array<{ path: string; authorization: string | undefined }>
  close(): Promise<void>
}

const canaries: Canary[] = []
afterEach(async () => {
  for (const c of canaries.splice(0)) await c.close()
})

/** A stand-in for "an internal service the server must not be talked into calling". */
async function canary(): Promise<Canary> {
  const hits: Canary['hits'] = []
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url ?? '', authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const c: Canary = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  }
  canaries.push(c)
  return c
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`

const createDevice = (h: Harness, s: Session, baseUrl: string, password = 'device-password-1') =>
  h.call('POST', 'integrations/sms/devices', {
    session: s,
    body: { label: 'Tablet', provider: 'smsgate', baseUrl, username: 'admin', password },
  })

describe('SEC-04 SMS device URL: SSRF', () => {
  const h = useHarness()

  it('refuses addresses that reach cloud metadata or link-local services, however they are spelled', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const s = await h.login(owner, '10.81.0.1')
    const results: Record<string, number> = {}
    for (const baseUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/',
      'http://2852039166/', // 169.254.169.254 as one decimal number
      'http://0xA9FEA9FE/',
      'http://[fd00:ec2::254]/',
      'http://[fe80::1]/',
      'http://metadata.google.internal/',
      'http://user:pass@100.64.0.7:8080/', // credentials in the URL
      'ftp://100.64.0.7/',
    ]) {
      results[baseUrl] = (await createDevice(h, s, baseUrl)).statusCode
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, 422])))
  })

  it('still accepts a tailnet or private address and a MagicDNS name', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const s = await h.login(owner, '10.81.0.2')
    for (const baseUrl of [
      'http://100.64.0.7:8080',
      'https://tablet.tail1234.ts.net',
      'http://192.168.1.50:8080',
    ]) {
      const res = await createDevice(h, s, baseUrl)
      expect([baseUrl, res.statusCode]).toEqual([baseUrl, 201])
    }
  })

  it('refuses an edit that points an existing device at a link-local address', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const s = await h.login(owner, '10.81.0.3')
    const device = (await createDevice(h, s, 'http://100.64.0.7:8080')).json() as Json
    const res = await h.call('PATCH', `integrations/sms/devices/${device.device.id}`, {
      session: s,
      body: { baseUrl: 'http://169.254.169.254/' },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('SEC-04 SMS device URL: stored credentials follow the address', () => {
  const h = useHarness()

  it('moving a device to another host needs the password again, so set.billing cannot read it by redirecting the server', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const accountant = await h.createUser({ email: 'daniel@example.test', roles: ['acct'] }) // holds set.billing
    const sup = await h.login(owner, '10.82.0.1')
    const acct = await h.login(accountant, '10.82.0.2')
    const real = await canary()
    const attacker = await canary()

    const created = (await createDevice(h, sup, real.url, 'the-device-password')).json() as Json
    const id = created.device.id as string

    // the accountant cannot read the password (it is never returned) but can change where the server sends it
    const patch = await h.call('PATCH', `integrations/sms/devices/${id}`, {
      session: acct,
      body: { baseUrl: attacker.url },
    })
    await h.call('POST', `integrations/sms/devices/${id}/test`, { session: acct })

    const stolen = attacker.hits.some((x) => x.authorization === basic('admin', 'the-device-password'))
    expect({ patch: patch.statusCode, stolen }).toEqual({ patch: 422, stolen: false })
  })

  it('editing the address of a device while supplying the password again still works', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const sup = await h.login(owner, '10.82.0.3')
    const first = await canary()
    const second = await canary()
    const id = ((await createDevice(h, sup, first.url, 'old-password-1')).json() as Json).device.id as string
    const patch = await h.call('PATCH', `integrations/sms/devices/${id}`, {
      session: sup,
      body: { baseUrl: second.url, password: 'new-password-1' },
    })
    expect(patch.statusCode).toBe(200)
    await h.call('POST', `integrations/sms/devices/${id}/test`, { session: sup })
    expect(second.hits.some((x) => x.authorization === basic('admin', 'new-password-1'))).toBe(true)
    // keeping the same address and omitting the password keeps the stored one
    const rename = await h.call('PATCH', `integrations/sms/devices/${id}`, {
      session: sup,
      body: { label: 'Front desk' },
    })
    expect(rename.statusCode).toBe(200)
  })
})

describe('SEC-04 SMS device URL: production refuses loopback', () => {
  const h = useHarness({
    env: {
      NODE_ENV: 'production',
      SESSION_SECRET: 'p'.repeat(40),
      COOKIE_SECURE: 'true',
      SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
  })

  it('does not let an administrator make the server call itself or another local service', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const s = await h.login(owner, '10.83.0.1')
    const local = await canary()

    const created = await createDevice(h, s, local.url)
    if (created.statusCode === 201) {
      const id = (created.json() as Json).device.id as string
      await h.call('POST', `integrations/sms/devices/${id}/test`, { session: s })
    }
    expect({ create: created.statusCode, localServiceHits: local.hits.length }).toEqual({
      create: 422,
      localServiceHits: 0,
    })
    for (const baseUrl of ['http://localhost:4000', 'http://[::1]:4000', 'http://127.1:5432']) {
      expect([baseUrl, (await createDevice(h, s, baseUrl)).statusCode]).toEqual([baseUrl, 422])
    }
  })
})
