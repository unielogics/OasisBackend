import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import { ConsoleProvider } from '../../../src/integrations/email/console-provider.js'
import { EmailError } from '../../../src/integrations/email/errors.js'
import { SesProvider } from '../../../src/integrations/email/ses-provider.js'
import { withSuppression } from '../../../src/integrations/email/suppression.js'
import { createEmailProvider } from '../../../src/integrations/email/config.js'

const reset = {
  template: 'password_reset',
  vars: { recipientName: 'Kevin', resetUrl: 'https://app.example.com/reset?t=abc', expiresMinutes: 30 },
}

describe('ConsoleProvider', () => {
  let dir: string
  const clock = new FixedClock('2026-06-13T10:36:00-04:00')
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'oasis-mail-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes a readable multipart .eml and keeps the message in the mailbox', async () => {
    const p = new ConsoleProvider({
      clock,
      dir,
      from: 'no-reply@oasis.example',
      fromName: 'Oasis Auto Spa',
      newId: () => 'sim-1',
    })
    const { id } = await p.send({ to: 'kevin@example.com', ...reset })
    expect(id).toBe('sim-1')

    const files = readdirSync(dir)
    expect(files).toEqual(['20260613T143600Z-sim-1.eml'])
    const eml = readFileSync(path.join(dir, files[0]!), 'utf8')
    expect(eml).toContain('From: "Oasis Auto Spa" <no-reply@oasis.example>')
    expect(eml).toContain('To: kevin@example.com')
    expect(eml).toContain('Subject: Reset your Oasis Auto Spa password')
    expect(eml).toContain('Date: Sat, 13 Jun 2026 14:36:00 +0000')
    expect(eml).toContain('MIME-Version: 1.0')
    expect(eml).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(eml).toContain('Content-Type: text/html; charset=UTF-8')
    expect(eml).toContain('X-Oasis-Template: password_reset')
    expect(eml).toMatch(/--oasis-sim1--\r\n$/)
    expect(eml).not.toMatch(/(?<!\r)\n/) // CRLF only

    expect(p.mailbox).toHaveLength(1)
    expect(p.last()).toMatchObject({
      to: 'kevin@example.com',
      template: 'password_reset',
      file: path.join(dir, files[0]!),
    })
    expect(p.last()!.text).toContain('https://app.example.com/reset?t=abc')
    expect(p.to('KEVIN@example.com')).toHaveLength(1)
    p.clear()
    expect(p.mailbox).toHaveLength(0)
  })

  it('quoted-printable survives long lines and non-ASCII', async () => {
    const p = new ConsoleProvider({ clock, dir, from: 'no-reply@oasis.example', newId: () => 'sim-2' })
    await p.send({
      to: 'a@example.com',
      template: 'closure_notice',
      vars: { customerName: 'Zoë', closureLabel: 'jeudi 13 juin', message: 'Café fermé. '.repeat(40) },
    })
    const eml = readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8')
    for (const line of eml.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
    expect(eml).toContain('Zo=C3=AB')
  })

  it('encodes a non-ASCII subject as RFC 2047', async () => {
    const p = new ConsoleProvider({ clock, dir, from: 'no-reply@oasis.example', newId: () => 'sim-3' })
    await p.send({ to: 'a@example.com', ...reset, subject: 'Réinitialisation du mot de passe' })
    const eml = readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8')
    expect(eml).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/)
  })

  it('memory-only mode writes nothing and onSend can persist', async () => {
    const seen: string[] = []
    const p = new ConsoleProvider({
      clock,
      dir: null,
      from: 'no-reply@oasis.example',
      onSend: (m) => void seen.push(m.id),
    })
    await p.send({ to: 'a@example.com', ...reset })
    expect(readdirSync(dir)).toEqual([])
    expect(seen).toHaveLength(1)
    expect(p.last()!.file).toBeUndefined()
  })

  it('rejects bad addresses and header-injection attempts before writing', async () => {
    const p = new ConsoleProvider({ clock, dir, from: 'no-reply@oasis.example' })
    for (const to of ['nope', 'a@b', 'a@example.com\r\nBcc: x@y.z', 'a b@example.com', '<a@example.com>']) {
      await expect(p.send({ to, ...reset })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' })
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it('uses the request reply-to over the configured one', async () => {
    const p = new ConsoleProvider({
      clock,
      dir: null,
      from: 'no-reply@oasis.example',
      replyTo: 'front@oasis.example',
    })
    await p.send({ to: 'a@example.com', ...reset })
    expect(p.last()!.replyTo).toBe('front@oasis.example')
    await p.send({ to: 'a@example.com', ...reset, replyTo: 'boss@oasis.example' })
    expect(p.last()!.replyTo).toBe('boss@oasis.example')
  })
})

describe('SesProvider', () => {
  const ses = mockClient(SESv2Client)
  beforeEach(() => ses.reset())
  const make = (extra: Partial<ConstructorParameters<typeof SesProvider>[0]> = {}) =>
    new SesProvider({
      client: new SESv2Client({
        region: 'us-east-1',
        credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'x' },
      }),
      from: 'no-reply@oasis.example',
      fromName: 'Oasis Auto Spa',
      ...extra,
    })

  it('sends one SendEmail with text + html, sender, reply-to, config set and template tag', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: '0100019abc-0000' })
    const out = await make({ replyTo: 'front@oasis.example', configurationSet: 'oasis-prod' }).send({
      to: 'kevin@example.com',
      ...reset,
    })
    expect(out).toEqual({ id: '0100019abc-0000' })
    const calls = ses.commandCalls(SendEmailCommand)
    expect(calls).toHaveLength(1)
    const input = calls[0]!.args[0].input
    expect(input.FromEmailAddress).toBe('"Oasis Auto Spa" <no-reply@oasis.example>')
    expect(input.Destination).toEqual({ ToAddresses: ['kevin@example.com'] })
    expect(input.ReplyToAddresses).toEqual(['front@oasis.example'])
    expect(input.ConfigurationSetName).toBe('oasis-prod')
    expect(input.EmailTags).toEqual([{ Name: 'template', Value: 'password_reset' }])
    const simple = input.Content!.Simple!
    expect(simple.Subject).toEqual({ Data: 'Reset your Oasis Auto Spa password', Charset: 'UTF-8' })
    expect(simple.Body!.Text!.Data).toContain('https://app.example.com/reset?t=abc')
    expect(simple.Body!.Html!.Data).toContain('<a href="https://app.example.com/reset?t=abc"')
    expect(simple.Body!.Html!.Charset).toBe('UTF-8')
  })

  it('omits optional parameters when not configured', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'm1' })
    await make().send({ to: 'kevin@example.com', ...reset })
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0].input
    expect(input).not.toHaveProperty('ReplyToAddresses')
    expect(input).not.toHaveProperty('ConfigurationSetName')
  })

  it('does not call SES when the template or address is invalid', async () => {
    const p = make()
    await expect(p.send({ to: 'bad', ...reset })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' })
    await expect(p.send({ to: 'a@example.com', template: 'nope', vars: {} })).rejects.toMatchObject({
      code: 'UNKNOWN_TEMPLATE',
    })
    await expect(p.send({ to: 'a@example.com', template: 'password_reset', vars: {} })).rejects.toMatchObject(
      { code: 'MISSING_VAR' },
    )
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0)
  })

  it('classifies rejections as permanent and throttling/outages as retryable', async () => {
    const p = make()
    const cases: Array<[Error & { $metadata?: { httpStatusCode: number } }, boolean]> = [
      [
        Object.assign(new Error('Email address is not verified.'), {
          name: 'MessageRejected',
          $metadata: { httpStatusCode: 400 },
        }),
        false,
      ],
      [
        Object.assign(new Error('suspended'), {
          name: 'AccountSuspendedException',
          $metadata: { httpStatusCode: 400 },
        }),
        false,
      ],
      [
        Object.assign(new Error('slow down'), {
          name: 'TooManyRequestsException',
          $metadata: { httpStatusCode: 429 },
        }),
        true,
      ],
      [
        Object.assign(new Error('boom'), {
          name: 'InternalServiceErrorException',
          $metadata: { httpStatusCode: 500 },
        }),
        true,
      ],
      [
        Object.assign(new Error('unavailable'), { name: 'UnknownError', $metadata: { httpStatusCode: 503 } }),
        true,
      ],
    ]
    for (const [err, retryable] of cases) {
      ses.reset()
      ses.on(SendEmailCommand).rejects(err)
      const e = await p.send({ to: 'a@example.com', ...reset }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(EmailError)
      expect((e as EmailError).retryable).toBe(retryable)
      expect((e as EmailError).code).toBe(retryable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED')
      expect((e as EmailError).message).toContain(err.name)
    }
  })

  it('fails when SES returns no MessageId', async () => {
    ses.on(SendEmailCommand).resolves({})
    await expect(make().send({ to: 'a@example.com', ...reset })).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
    })
  })

  it('refuses a malformed sender at construction', () => {
    expect(() => make({ from: 'not-an-address' })).toThrow(/SES_FROM_ADDRESS/)
  })
})

describe('suppression and factory', () => {
  const ses = mockClient(SESv2Client)
  beforeEach(() => ses.reset())

  it('withSuppression blocks suppressed recipients without calling the inner provider', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'm1' })
    const inner = new SesProvider({
      client: new SESv2Client({ region: 'us-east-1' }),
      from: 'no-reply@oasis.example',
    })
    const p = withSuppression(inner, (a) => a === 'bounced@example.com')
    await expect(p.send({ to: 'Bounced@Example.com', ...reset })).rejects.toMatchObject({
      code: 'SUPPRESSED',
      retryable: false,
    })
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0)
    await p.send({ to: 'ok@example.com', ...reset })
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1)
  })

  it('EMAIL_PROVIDER=sim yields the console driver with env-derived options', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mail-'))
    try {
      const p = createEmailProvider(
        {
          EMAIL_PROVIDER: 'sim',
          AWS_REGION: 'us-east-1',
          SES_FROM_ADDRESS: 'hello@oasis.example',
          EMAIL_CONSOLE_DIR: dir,
          SES_FROM_NAME: 'Oasis',
        },
        { clock: new FixedClock('2026-06-13T10:36:00-04:00') },
      )
      expect(p).toBeInstanceOf(ConsoleProvider)
      await p.send({ to: 'a@example.com', ...reset })
      expect(readdirSync(dir)).toHaveLength(1)
      expect(readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8')).toContain(
        'From: "Oasis" <hello@oasis.example>',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('EMAIL_PROVIDER=ses builds the SES driver, passes env options, and applies suppression', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'live-1' })
    const p = createEmailProvider(
      {
        EMAIL_PROVIDER: 'ses',
        AWS_REGION: 'us-east-1',
        SES_FROM_ADDRESS: 'hello@oasis.example',
        SES_CONFIGURATION_SET: 'cfg',
        SES_REPLY_TO: 'help@oasis.example',
      },
      { sesClient: new SESv2Client({ region: 'us-east-1' }), isSuppressed: () => false },
    )
    expect(await p.send({ to: 'a@example.com', ...reset })).toEqual({ id: 'live-1' })
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0].input
    expect(input.ConfigurationSetName).toBe('cfg')
    expect(input.ReplyToAddresses).toEqual(['help@oasis.example'])
    expect(input.FromEmailAddress).toBe('"Oasis Auto Spa" <hello@oasis.example>')
  })

  it('EMAIL_PROVIDER=ses without a sender fails fast', () => {
    expect(() =>
      createEmailProvider({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'us-east-1', SES_FROM_ADDRESS: undefined }),
    ).toThrow(/SES_FROM_ADDRESS/)
  })
})
