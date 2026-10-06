import { EmailError } from './errors.js'

const ADDRESS = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/

export function assertAddress(addr: string, field = 'address'): string {
  if (addr.length > 254 || !ADDRESS.test(addr)) {
    throw new EmailError('INVALID_ADDRESS', `${field} is not a valid email address`)
  }
  return addr
}

/** Lowercased form used as the suppression-list key. */
export const normalizeAddress = (addr: string): string => addr.trim().toLowerCase()

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)

/** RFC 2047 encoded-word(s) for header text; plain ASCII passes through. */
export function encodeHeaderText(s: string): string {
  if (isAscii(s)) return s
  const words: string[] = []
  let chunk = ''
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    chunk = ''
  }
  for (const ch of s) {
    // 45 bytes of UTF-8 encode to 60 base64 chars, keeping each encoded word under 75 characters.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) flush()
    chunk += ch
  }
  flush()
  return words.join('\r\n ')
}

export function formatAddress(addr: string, name?: string): string {
  if (!name) return addr
  const clean = name.replace(/[\r\n]+/g, ' ').trim()
  if (!clean) return addr
  const display = isAscii(clean) ? `"${clean.replace(/(["\\])/g, '\\$1')}"` : encodeHeaderText(clean)
  return `${display} <${addr}>`
}

/** Quoted-printable (RFC 2045) so the .eml stays readable for ASCII-heavy bodies. */
export function quotedPrintable(input: string): string {
  const out: string[] = []
  for (const rawLine of input.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    const bytes = Buffer.from(rawLine, 'utf8')
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number
      const last = i === bytes.length - 1
      let tok: string
      if (b === 0x20 || b === 0x09)
        tok = last ? `=${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b)
      else if (b >= 0x21 && b <= 0x7e && b !== 0x3d) tok = String.fromCharCode(b)
      else tok = `=${b.toString(16).toUpperCase().padStart(2, '0')}`
      if (line.length + tok.length > 75) {
        out.push(`${line}=`)
        line = ''
      }
      line += tok
    }
    out.push(line)
  }
  return out.join('\r\n')
}

export interface MimeInput {
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html: string
  date: Date
  messageId: string
  template?: string
}

export function buildMime(m: MimeInput): string {
  const boundary = `oasis-${m.messageId.replace(/[^A-Za-z0-9]/g, '')}`
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${encodeHeaderText(m.subject)}`,
    `Date: ${m.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${m.messageId}@oasis.local>`,
    ...(m.template ? [`X-Oasis-Template: ${m.template}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(body),
    ].join('\r\n')
  return [
    headers.join('\r\n'),
    '',
    part('text/plain', m.text),
    part('text/html', m.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}
