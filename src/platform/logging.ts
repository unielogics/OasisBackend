// Structured logging: pino with secret redaction everywhere and PII masking (phone, email) at info and above.
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino'
import { maskEmail, maskPhone } from './phone.js'

export type { Logger } from 'pino'

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-signature"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.password_enc',
  'password',
  'token',
  'secret',
]

const PHONE_KEYS = /^(phone|phone_?number|phone_?e164|mobile|msisdn|recipient|sms_?to)$/i
const EMAIL_KEYS = /^(email|e_?mail|[a-z_]*_email|customer_?email)$/i
const EITHER_KEYS = /^(to|from|address)$/i
// Quantifiers are bounded so a megabyte of log text cannot trigger catastrophic backtracking.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g
const E164_RE = /\+\d{8,15}/g

const looksLikeEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
const looksLikePhone = (s: string): boolean =>
  /^\+?[\d\s().-]{7,20}$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 7 && !/^\d{4}-\d{2}-\d{2}/.test(s)

const MAX_LOGGED_STRING = 8192

export function maskText(s: string): string {
  if (s.length > MAX_LOGGED_STRING)
    s = `${s.slice(0, MAX_LOGGED_STRING)}...[${s.length - MAX_LOGGED_STRING} more characters]`
  return s.replace(EMAIL_RE, (m) => maskEmail(m)).replace(E164_RE, (m) => maskPhone(m))
}

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

export function maskPii(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value)
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Error ||
    value instanceof Date ||
    depth > 5
  )
    return value
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => maskPii(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    // the framework's request and reply objects go to their serializers below, which keep only safe, redacted fields
    if ((k === 'req' || k === 'res') && v !== null && typeof v === 'object' && !isPlainObject(v)) {
      out[k] = v
      continue
    }
    if (typeof v === 'string') {
      if (PHONE_KEYS.test(k)) out[k] = maskPhone(v)
      else if (EMAIL_KEYS.test(k)) out[k] = maskEmail(v)
      else if (EITHER_KEYS.test(k) && looksLikeEmail(v)) out[k] = maskEmail(v)
      else if (EITHER_KEYS.test(k) && looksLikePhone(v)) out[k] = maskPhone(v)
      else out[k] = maskText(v)
    } else out[k] = maskPii(v, depth + 1)
  }
  return out
}

// Credentials (tokens, codes, keys) and what someone typed into a search box (a customer's name, phone or plate).
const SENSITIVE_QUERY =
  /^(token|code|key|secret|password|signature|sig|invite|reset|q|query|search|term|phone|email|name|plate)$/i
// A path segment after one of these is a link token (the arrival link /a/<token>, invite and reset pages).
const TOKEN_PATH_PREFIX = /^(a|arrive|arrival|invite|invites|reset|reset-password|password-reset|accept|t)$/i
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{16,}$/
// Any other segment that looks like one of our opaque tokens (base64url of 32 bytes is 43 characters; UUIDs and the 24-character
// Squarespace ids stay readable).
const OPAQUE_SEGMENT = /^(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}$/
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function redactPath(path: string): string {
  const parts = path.split('/')
  return parts
    .map((seg, i) => {
      if (!seg || UUID_SEGMENT.test(seg)) return seg
      if (i > 0 && TOKEN_PATH_PREFIX.test(parts[i - 1] ?? '') && TOKEN_SEGMENT.test(seg)) return '[redacted]'
      return OPAQUE_SEGMENT.test(seg) ? '[redacted]' : seg
    })
    .join('/')
}

/** Replaces link tokens in the path and the values of sensitive query parameters so URLs are safe to log. */
export function redactUrl(url: string): string {
  const i = url.indexOf('?')
  const path = redactPath(i < 0 ? url : url.slice(0, i))
  if (i < 0) return path
  const q = new URLSearchParams(url.slice(i + 1))
  for (const k of [...q.keys()]) if (SENSITIVE_QUERY.test(k)) q.set(k, '[redacted]')
  return `${path}?${q.toString()}`
}

export interface LoggerConfig {
  level?: string
  pretty?: boolean
}

export function loggerOptions(cfg: LoggerConfig = {}): LoggerOptions {
  const opts: LoggerOptions = {
    level: cfg.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      // Error text (message, stack, cause chain) often embeds user input such as a phone number or email.
      // Call sites log both `{ err }` (an Error) and `{ err: error.message }` (a string): pino hands either to this serializer.
      err: (e: unknown) => {
        if (typeof e === 'string') return maskText(e)
        if (e === null || typeof e !== 'object') return e
        const o = pino.stdSerializers.err(e as Error)
        return { ...o, message: maskText(o.message ?? ''), stack: o.stack ? maskText(o.stack) : o.stack }
      },
      req: (r: { method?: string; url?: string; hostname?: string; host?: string; ip?: string }) => ({
        method: r.method,
        url: r.url ? maskText(redactUrl(r.url)) : r.url,
        host: r.hostname ?? r.host,
        remoteAddress: r.ip,
      }),
      res: (r: { statusCode?: number }) => ({ statusCode: r.statusCode }),
    },
    hooks: {
      logMethod(args, method, level) {
        // info (30) and above are masked; debug/trace keep full values for local diagnosis.
        const masked = level >= 30 ? (args.map((a) => maskPii(a)) as unknown as typeof args) : args
        return method.apply(this, masked)
      },
    },
  }
  if (cfg.pretty)
    opts.transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
  return opts
}

export function createLogger(cfg: LoggerConfig = {}, stream?: DestinationStream): Logger {
  const opts = loggerOptions(cfg)
  return stream ? pino(opts, stream) : pino(opts)
}
