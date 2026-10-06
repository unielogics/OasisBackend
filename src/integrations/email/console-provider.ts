import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EmailProvider, EmailRequest } from '../ports/email.js'
import type { Clock } from '../../platform/clock.js'
import { assertAddress, buildMime, formatAddress } from './mime.js'
import { renderTemplate } from './templates.js'

export interface SentEmail {
  id: string
  to: string
  from: string
  replyTo?: string
  template: string
  subject: string
  text: string
  html: string
  sentAt: Date
  /** Absolute path of the .eml written for this message, when a mail directory is configured. */
  file?: string
}

export interface ConsoleProviderOptions {
  clock: Clock
  /** Directory for .eml files (default ./.data/mail). `null` keeps the mailbox in memory only. */
  dir?: string | null
  from: string
  fromName?: string
  replyTo?: string
  newId?: () => string
  /** Hook for persisting to `outbox_emails` (the dev mailbox UI reads it). Errors propagate to the caller. */
  onSend?: (mail: SentEmail) => Promise<void> | void
}

/** Dev/test email driver: renders exactly what SES would send, stores it, and delivers nothing. */
export class ConsoleProvider implements EmailProvider {
  private readonly box: SentEmail[] = []
  private readonly dir: string | null
  private readonly newId: () => string

  constructor(private readonly opts: ConsoleProviderOptions) {
    this.dir = opts.dir === null ? null : path.resolve(opts.dir ?? '.data/mail')
    this.newId = opts.newId ?? (() => `sim-${randomUUID()}`)
  }

  async send(req: EmailRequest): Promise<{ id: string }> {
    assertAddress(req.to, 'to')
    if (req.replyTo) assertAddress(req.replyTo, 'replyTo')
    const rendered = renderTemplate(req)
    const id = this.newId()
    const sentAt = this.opts.clock.now()
    const from = formatAddress(this.opts.from, this.opts.fromName)
    const replyTo = req.replyTo ?? this.opts.replyTo
    const mail: SentEmail = {
      id,
      to: req.to,
      from,
      ...(replyTo ? { replyTo } : {}),
      template: req.template,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      sentAt,
    }
    if (this.dir) {
      await mkdir(this.dir, { recursive: true })
      const stamp = sentAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
      const file = path.join(this.dir, `${stamp}-${id.replace(/[^A-Za-z0-9_-]/g, '')}.eml`)
      const eml = buildMime({
        from,
        to: req.to,
        ...(replyTo ? { replyTo } : {}),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        date: sentAt,
        messageId: id,
        template: req.template,
      })
      await writeFile(file, eml, { flag: 'wx' })
      mail.file = file
    }
    this.box.push(mail)
    await this.opts.onSend?.(mail)
    return { id }
  }

  /** In-memory mailbox, oldest first. */
  get mailbox(): readonly SentEmail[] {
    return this.box
  }

  last(): SentEmail | undefined {
    return this.box[this.box.length - 1]
  }

  to(address: string): SentEmail[] {
    const a = address.toLowerCase()
    return this.box.filter((m) => m.to.toLowerCase() === a)
  }

  clear(): void {
    this.box.length = 0
  }
}
