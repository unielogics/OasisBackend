import { existsSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { signWebhook } from '../../src/integrations/smsgate/signature.js'
import { main, SMSGATE_ITEMS } from '../../scripts/verify-live/smsgate.js'
import { ListenerWatcher } from '../../scripts/verify-live/watch.js'
import { runVerify, statusOf, type CliRun } from './verify-live-helpers.js'

const runs: CliRun[] = []
afterEach(() => {
  while (runs.length) runs.pop()!.cleanup()
})
const run = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> => {
  const r = await runVerify(main, argv, env)
  runs.push(r)
  return r
}

describe('verify:smsgate against the simulator on port 4591', () => {
  it('a full send, watch, reply and multipart run passes every item the simulator can answer', async () => {
    const r = await run([
      '--sim',
      '--send',
      '--to',
      '+17865550151',
      '--watch',
      '--replies',
      '--multipart',
      '--event-timeout',
      '5',
      '--reply-timeout',
      '5',
    ])
    expect(r.out).toMatch(/PASS\s+SG-04/)
    const s = statusOf(r, 'smsgate')
    for (const id of [
      'SG-01',
      'SG-02',
      'SG-03',
      'SG-04',
      'SG-05',
      'SG-06',
      'SG-07',
      'SG-08',
      'SG-10',
      'SG-13',
      'SG-14',
      'SG-15',
      'SG-16',
      'SG-17',
      'SG-20',
      'SG-B1',
      'SG-B2',
      'SG-B3',
      'SG-B4',
      'SG-B5',
      'SG-H1',
    ])
      expect([id, s[id]]).toEqual([id, 'PASS'])
    // the items that need a person, a reboot, or a hardware limit are listed as SKIP with a reason, never silently dropped
    for (const id of ['SG-09', 'SG-11', 'SG-12', 'SG-18', 'SG-19', 'SG-B6'])
      expect([id, s[id]]).toEqual([id, 'SKIP'])
    expect(Object.keys(s)).toHaveLength(SMSGATE_ITEMS.length)
    expect(r.code).toBe(0)
    const json = r.json('smsgate')
    expect(json.mode).toBe('sim')
    expect(json.summary.fail).toBe(0)
    expect(readdirSync(r.outDir).sort()).toEqual([
      `${new Date().toISOString().slice(0, 10)}-smsgate.json`,
      `${new Date().toISOString().slice(0, 10)}-smsgate.md`,
    ])
    const md = r.markdown('smsgate')
    expect(md).toContain('| SG-06 |')
    expect(md).not.toContain('+17865550151') // the recipient is masked in console and files
    expect(r.out).not.toContain('+17865550151')
  })

  it('reads only by default: no send flag, no text goes out, send-dependent items are SKIP with the flag to use', async () => {
    const r = await run(['--sim'])
    expect(r.code).toBe(0)
    expect(r.out).not.toMatch(/sending \d of \d/)
    const j = r.json('smsgate')
    const byId = Object.fromEntries(j.items.map((i) => [i.id, i]))
    expect(byId['SG-04']).toMatchObject({ status: 'SKIP' })
    expect(byId['SG-04']!.detail).toMatch(/--send --to/)
    expect(byId['SG-B1']!.status).toBe('PASS')
    expect(byId['SG-03']!.status).toBe('PASS')
  })

  it('measures the retry schedule: the first deliveries are refused with 500 and the gaps are reported', async () => {
    const r = await run([
      '--sim',
      '--send',
      '--to',
      '+17865550151',
      '--watch',
      '--reject',
      '2',
      '--event-timeout',
      '5',
    ])
    const s = statusOf(r, 'smsgate')
    expect(s['SG-09']).toBe('PASS')
    expect(r.json('smsgate').items.find((i) => i.id === 'SG-09')!.detail).toMatch(
      /3 attempts of one delivery, gaps \d/,
    )
    expect(s['SG-B4']).toBe('PASS')
  })

  it('runs the burst measurement only with --yes and reports how many texts left Pending', async () => {
    await expect(
      run(['--sim', '--send', '--to', '+17865550151', '--measure-limit', '5']),
    ).resolves.toMatchObject({ code: 2 })
    const r = await run([
      '--sim',
      '--send',
      '--to',
      '+17865550151',
      '--measure-limit',
      '5',
      '--yes',
      '--event-timeout',
      '1',
    ])
    expect(statusOf(r, 'smsgate')['SG-11']).toBe('PASS')
    expect(r.json('smsgate').items.find((i) => i.id === 'SG-11')!.detail).toMatch(/5 of 5 left Pending/)
  })

  it('--sim-number sends once through that SIM slot', async () => {
    const r = await run([
      '--sim',
      '--send',
      '--to',
      '+17865550151',
      '--sim-number',
      '2',
      '--event-timeout',
      '2',
    ])
    expect(statusOf(r, 'smsgate')['SG-18']).toBe('PASS')
  })
})

describe('verify:smsgate without a device', () => {
  it('exits 2 and names every missing variable, without writing a report', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    for (const v of ['SMSGATE_DEVICE_URL', 'SMSGATE_USERNAME', 'SMSGATE_PASSWORD', 'SMSGATE_WEBHOOK_SECRET'])
      expect(r.out).toContain(v)
    expect(existsSync(r.outDir) ? readdirSync(r.outDir) : []).toEqual([])
  })

  it('names only what is still missing', async () => {
    const r = await run([], { SMSGATE_DEVICE_URL: 'http://100.64.0.7:8080', SMSGATE_USERNAME: 'u' })
    expect(r.code).toBe(2)
    expect(r.out).toContain('SMSGATE_PASSWORD')
    expect(r.out).toContain('SMSGATE_WEBHOOK_SECRET')
    expect(r.out).not.toMatch(/SMSGATE_DEVICE_URL:/)
  })

  it('refuses to send without an explicit recipient, and an unusable number', async () => {
    const a = await run(['--sim', '--send'])
    expect(a.code).toBe(2)
    expect(a.out).toMatch(/--send needs --to/)
    const b = await run(['--sim', '--send', '--to', '12345'])
    expect(b.code).toBe(2)
    expect(b.out).toMatch(/not a dialable number/)
    const c = await run(['--sim', '--nonsense'])
    expect(c.code).toBe(2)
  })

  it('an unreachable device is a FAIL with a fix, exit 1, and the password never reaches the output', async () => {
    const r = await run([], {
      SMSGATE_DEVICE_URL: 'http://127.0.0.1:4599',
      SMSGATE_USERNAME: 'user',
      SMSGATE_PASSWORD: 'very-secret-pass',
      SMSGATE_WEBHOOK_SECRET: 'key-key-key-key',
    })
    expect(r.code).toBe(1)
    const s = statusOf(r, 'smsgate')
    expect(s['SG-B1']).toBe('FAIL')
    expect(s['SG-20']).toBe('FAIL')
    expect(r.out).toMatch(/fix: Is the tablet awake/)
    expect(r.out + r.markdown('smsgate')).not.toContain('very-secret-pass')
  })
})

describe('the watch listener', () => {
  const secret = 'listener-secret-1'
  const body = (event: string, payload: Record<string, unknown>, id = 'env-1'): string =>
    JSON.stringify({ id, deviceId: 'dev', event, webhookId: 'oasis-x', payload })
  const post = (
    port: number,
    path: string,
    raw: string,
    key: string,
    ts = String(Math.floor(Date.now() / 1000)),
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-timestamp': ts,
        'x-signature': signWebhook(key, raw, ts),
      },
      body: raw,
    })

  it('accepts a good delivery, refuses a bad signature, and answers the probe like the hooks listener', async () => {
    const w = new ListenerWatcher({
      host: '127.0.0.1',
      port: 4594,
      secret,
      toleranceSec: 86400,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    await w.start()
    try {
      const good = body('sms:sent', { messageId: 'm1', partsCount: 1 })
      expect((await post(4594, '/hooks/smsgate/abc', good, secret)).status).toBe(200)
      const bad = body('sms:sent', { messageId: 'm2' }, 'env-2')
      expect((await post(4594, '/hooks/smsgate/abc', bad, 'the-wrong-key')).status).toBe(401)
      expect((await post(4594, '/hooks/smsgate/verify-live-probe', '{}', secret)).status).toBe(404)
      expect(await (await post(4594, '/hooks/smsgate/verify-live-probe', '{}', secret)).json()).toEqual({
        ok: false,
        status: 'unknown_device',
      })
      expect(await (await post(4594, '/elsewhere', '{}', secret)).json()).toEqual({
        ok: false,
        status: 'not_found',
      })
      expect(w.events.map((e) => [e.event, e.signatureOk])).toEqual([
        ['sms:sent', true],
        ['sms:sent', false],
      ])
      expect(w.events[1]!.rejected).toMatch(/^bad_signature/)
    } finally {
      await w.stop()
    }
  })

  it('a second listener on a taken port is reported, not thrown', async () => {
    const { tryListener } = await import('../../scripts/verify-live/watch.js')
    const first = await tryListener({
      host: '127.0.0.1',
      port: 4595,
      secret,
      toleranceSec: 60,
      sleep: async () => {},
    })
    try {
      expect(first).toBeDefined()
      expect(
        await tryListener({ host: '127.0.0.1', port: 4595, secret, toleranceSec: 60, sleep: async () => {} }),
      ).toBeUndefined()
    } finally {
      await first?.stop()
    }
  })
})
