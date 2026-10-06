import { beforeAll, describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import {
  buildStringToSign,
  isSnsUrl,
  parseSnsEnvelope,
  SnsVerifier,
  SnsVerificationError,
} from '../../../src/integrations/email/sns.js'
import { createSesWebhookHandler, decisionsFromQueueBody } from '../../../src/integrations/email/webhook.js'
import type { FeedbackDecision } from '../../../src/integrations/email/ses-events.js'
import {
  CERT_URL,
  TOPIC,
  generateTestCert,
  sesNotification,
  signedEnvelope,
  type TestCert,
} from './helpers/sns-fixtures.js'

let cert: TestCert
let other: TestCert
let now: Date
beforeAll(() => {
  cert = generateTestCert()
  other = generateTestCert()
  // openssl stamps notBefore at second resolution; start the clock a minute later so the cert is valid.
  now = new Date(Date.now() + 60_000)
})

const verifier = (over: Partial<ConstructorParameters<typeof SnsVerifier>[0]> = {}, fetched: string[] = []) =>
  new SnsVerifier({
    clock: new FixedClock(now),
    allowedTopicArns: [TOPIC],
    fetchCertificate: async (url) => {
      fetched.push(url)
      return cert.certPem
    },
    ...over,
  })

const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(SnsVerificationError)
    return (e as SnsVerificationError).code
  }
  throw new Error('expected rejection')
}

describe('string to sign', () => {
  it('notification: sorted fields, Subject only when present, trailing newline', () => {
    const e = signedEnvelope(cert, { Subject: 'My subject' })
    expect(buildStringToSign(e)).toBe(
      `Message\n{"hello":"world"}\nMessageId\n${e.MessageId}\nSubject\nMy subject\nTimestamp\n${e.Timestamp}\nTopicArn\n${TOPIC}\nType\nNotification\n`,
    )
    expect(buildStringToSign(signedEnvelope(cert))).not.toContain('Subject')
  })
  it('subscription confirmation includes SubscribeURL and Token', () => {
    const e = signedEnvelope(cert, {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      Token: 't',
    })
    expect(buildStringToSign(e)).toBe(
      `Message\n{"hello":"world"}\nMessageId\n${e.MessageId}\nSubscribeURL\n${e.SubscribeURL}\nTimestamp\n${e.Timestamp}\nToken\nt\nTopicArn\n${TOPIC}\nType\nSubscriptionConfirmation\n`,
    )
  })
})

describe('certificate URL allow-list', () => {
  it.each([
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem', true],
    ['https://sns.eu-west-2.amazonaws.com/x.pem', true],
    ['https://sns.cn-north-1.amazonaws.com.cn/x.pem', true],
    ['https://sns.us-gov-west-1.amazonaws.com/x.pem', true],
    ['http://sns.us-east-1.amazonaws.com/x.pem', false],
    ['https://sns.us-east-1.amazonaws.com.evil.com/x.pem', false],
    ['https://evil.com/sns.us-east-1.amazonaws.com/x.pem', false],
    ['https://sns.us-east-1.amazonaws.com@evil.com/x.pem', false],
    ['https://user:pw@sns.us-east-1.amazonaws.com/x.pem', false],
    ['https://sns.us-east-1.amazonaws.com:8443/x.pem', false],
    ['https://s3.us-east-1.amazonaws.com/x.pem', false],
    ['https://sns.us-east-1.amazonaws.com/x.txt', false],
    ['https://snsXus-east-1.amazonaws.com/x.pem', false],
    ['not a url', false],
  ])('%s -> %s', (u, ok) => expect(isSnsUrl(u, { pem: true })).toBe(ok))
})

describe('SnsVerifier', () => {
  it.each(['1', '2'] as const)('accepts a valid SignatureVersion %s message', async (v) => {
    await expect(
      verifier().verify(signedEnvelope(cert, { SignatureVersion: v, Subject: 'hi' })),
    ).resolves.toBeUndefined()
  })

  it('caches the certificate per URL', async () => {
    const fetched: string[] = []
    const v = verifier({}, fetched)
    await v.verify(signedEnvelope(cert))
    await v.verify(signedEnvelope(cert, { MessageId: 'other' }))
    expect(fetched).toEqual([CERT_URL])
  })

  it('rejects a tampered message body', async () => {
    const e = signedEnvelope(cert)
    expect(await code(verifier().verify({ ...e, Message: '{"hello":"mallory"}' }))).toBe('BAD_SIGNATURE')
  })
  it('rejects a tampered subject, topic-consistent fields and timestamp', async () => {
    const e = signedEnvelope(cert, { Subject: 'a' })
    expect(await code(verifier().verify({ ...e, Subject: 'b' }))).toBe('BAD_SIGNATURE')
    expect(await code(verifier().verify({ ...e, Timestamp: '2026-10-06T12:00:01.000Z' }))).toBe(
      'BAD_SIGNATURE',
    )
  })
  it('rejects a signature made with a different key', async () => {
    expect(await code(verifier().verify(signedEnvelope(other)))).toBe('BAD_SIGNATURE')
  })
  it('rejects garbage signatures', async () => {
    expect(await code(verifier().verify(signedEnvelope(cert, { Signature: 'AAAA' })))).toBe('BAD_SIGNATURE')
  })
  it('rejects a version downgrade (signature over SHA256 claimed as version 1)', async () => {
    const e = signedEnvelope(cert, { SignatureVersion: '2' })
    expect(await code(verifier().verify({ ...e, SignatureVersion: '1' }))).toBe('BAD_SIGNATURE')
  })

  it('rejects an unexpected topic before fetching anything', async () => {
    const fetched: string[] = []
    const e = signedEnvelope(cert, { TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker' })
    expect(await code(verifier({}, fetched).verify(e))).toBe('UNEXPECTED_TOPIC')
    expect(fetched).toEqual([])
  })

  it('rejects a certificate URL outside SNS without fetching it', async () => {
    const fetched: string[] = []
    const e = signedEnvelope(cert, { SigningCertURL: 'https://evil.example.com/cert.pem' })
    expect(await code(verifier({}, fetched).verify(e))).toBe('BAD_CERT_URL')
    expect(fetched).toEqual([])
  })

  it('maps a fetch failure and a non-PEM response to distinct errors', async () => {
    const down = verifier({
      fetchCertificate: async () => {
        throw new Error('ECONNRESET')
      },
    })
    expect(await code(down.verify(signedEnvelope(cert)))).toBe('CERT_FETCH_FAILED')
    const junk = verifier({ fetchCertificate: async () => 'not a certificate' })
    expect(await code(junk.verify(signedEnvelope(cert)))).toBe('BAD_CERT')
  })

  it('rejects an expired or not-yet-valid certificate using the injected clock', async () => {
    const future = new FixedClock(new Date(now.getTime() + 400 * 24 * 3600 * 1000))
    expect(await code(verifier({ clock: future }).verify(signedEnvelope(cert)))).toBe('BAD_CERT')
    const past = new FixedClock(new Date(now.getTime() - 3 * 24 * 3600 * 1000))
    expect(await code(verifier({ clock: past }).verify(signedEnvelope(cert)))).toBe('BAD_CERT')
  })

  it('enforces the optional replay window', async () => {
    const e = signedEnvelope(cert, { Timestamp: new Date(now.getTime() - 3600_000).toISOString() })
    await expect(verifier({ maxAgeSec: 7200 }).verify(e)).resolves.toBeUndefined()
    expect(
      await code(
        verifier({ maxAgeSec: 600 }).verify(
          signedEnvelope(cert, { Timestamp: new Date(now.getTime() - 3600_000).toISOString() }),
        ),
      ),
    ).toBe('STALE')
  })
})

describe('parseSnsEnvelope', () => {
  it('rejects non-JSON, missing fields and confirmations without a token', () => {
    expect(() => parseSnsEnvelope('nope')).toThrow(/valid JSON/)
    expect(() => parseSnsEnvelope('{}')).toThrow(/missing/)
    const e = signedEnvelope(cert, { Type: 'SubscriptionConfirmation' })
    expect(() => parseSnsEnvelope(JSON.stringify(e))).toThrow(/SubscribeURL/)
  })
})

describe('webhook handler', () => {
  const collect = () => {
    const decisions: FeedbackDecision[] = []
    const confirmed: string[] = []
    const handler = createSesWebhookHandler({
      verifier: verifier(),
      onDecisions: (d) => void decisions.push(...d),
      confirm: async (url) => {
        confirmed.push(url)
        return { ok: true, status: 200 }
      },
    })
    return { handler, decisions, confirmed }
  }
  const body = (e: object) => JSON.stringify(e)

  it('confirms a subscription after verifying its signature', async () => {
    const { handler, confirmed } = collect()
    const url = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=abc'
    const r = await handler(
      body(
        signedEnvelope(cert, {
          Type: 'SubscriptionConfirmation',
          SubscribeURL: url,
          Token: 'abc',
          Message: 'Please confirm',
        }),
      ),
    )
    expect(r.status).toBe(200)
    expect(confirmed).toEqual([url])
  })

  it('does not follow a SubscribeURL on a non-SNS host even when the signature is valid', async () => {
    const { handler, confirmed } = collect()
    const r = await handler(
      body(
        signedEnvelope(cert, {
          Type: 'SubscriptionConfirmation',
          SubscribeURL: 'https://evil.example.com/confirm',
          Token: 'abc',
        }),
      ),
    )
    expect(r.status).toBe(400)
    expect(confirmed).toEqual([])
  })

  it('does not confirm a forged subscription request', async () => {
    const { handler, confirmed } = collect()
    const forged = signedEnvelope(other, {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?x=1',
      Token: 'abc',
    })
    expect((await handler(body(forged))).status).toBe(403)
    expect(confirmed).toEqual([])
  })

  it('asks SNS to retry when the confirmation GET fails', async () => {
    const h = createSesWebhookHandler({
      verifier: verifier(),
      onDecisions: () => undefined,
      confirm: async () => ({ ok: false, status: 500 }),
    })
    const e = signedEnvelope(cert, {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?x=1',
      Token: 't',
    })
    expect((await h(body(e))).status).toBe(502)
  })

  it('turns a verified bounce notification into a suppression decision', async () => {
    const { handler, decisions } = collect()
    const r = await handler(
      body(signedEnvelope(cert, { Message: sesNotification('bounce', 'Jane@Example.com') })),
    )
    expect(r).toMatchObject({ status: 200 })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      action: 'suppress',
      reason: 'hard_bounce',
      address: 'jane@example.com',
    })
  })

  it('rejects an unsigned or tampered notification with 403 and records nothing', async () => {
    const { handler, decisions } = collect()
    const e = signedEnvelope(cert, { Message: sesNotification('delivery') })
    expect((await handler(body({ ...e, Message: sesNotification('bounce') }))).status).toBe(403)
    expect((await handler(body({ ...e, Signature: '' }))).status).toBe(400)
    expect((await handler('garbage')).status).toBe(400)
    expect(decisions).toEqual([])
  })

  it('acknowledges non-SES test messages without recording', async () => {
    const { handler, decisions } = collect()
    const r = await handler(body(signedEnvelope(cert, { Message: 'just a test' })))
    expect(r.status).toBe(200)
    expect(decisions).toEqual([])
  })

  it('returns 500 (so SNS retries) when persisting fails, 503 when the cert is unreachable', async () => {
    const failing = createSesWebhookHandler({
      verifier: verifier(),
      onDecisions: () => {
        throw new Error('db down')
      },
    })
    expect(
      (await failing(body(signedEnvelope(cert, { Message: sesNotification('complaint') })))).status,
    ).toBe(500)
    const noCert = createSesWebhookHandler({
      verifier: verifier({
        fetchCertificate: async () => {
          throw new Error('x')
        },
      }),
      onDecisions: () => undefined,
    })
    expect((await noCert(body(signedEnvelope(cert)))).status).toBe(503)
  })
})

describe('SQS path', () => {
  it('unwraps an SNS envelope and also accepts raw message delivery', async () => {
    const wrapped = JSON.stringify(signedEnvelope(cert, { Message: sesNotification('complaint') }))
    expect((await decisionsFromQueueBody(wrapped))[0]).toMatchObject({
      action: 'suppress',
      reason: 'complaint',
    })
    expect((await decisionsFromQueueBody(sesNotification('delivery')))[0]).toMatchObject({
      action: 'delivered',
    })
  })
  it('verifies the envelope when a verifier is supplied', async () => {
    const e = signedEnvelope(cert, { Message: sesNotification('bounce') })
    const bad = JSON.stringify({ ...e, Message: sesNotification('delivery') })
    expect(await code(decisionsFromQueueBody(bad, { verifier: verifier() }))).toBe('BAD_SIGNATURE')
    expect(await decisionsFromQueueBody(JSON.stringify(e), { verifier: verifier() })).toHaveLength(1)
  })
})
