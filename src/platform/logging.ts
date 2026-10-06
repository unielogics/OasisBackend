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

export function maskPii(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value)
  if (value === null || typeof value !== 'object' || value instanceof Error || depth > 5) return value
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => maskPii(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
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

const SENSITIVE_QUERY = /^(token|code|key|secret|password|signature|sig|invite|reset)$/i

/** Replaces the values of sensitive query parameters so URLs are safe to log. */
export function redactUrl(url: string): string {
  const i = url.indexOf('?')
  if (i < 0) return url
  const q = new URLSearchParams(url.slice(i + 1))
  for (const k of [...q.keys()]) if (SENSITIVE_QUERY.test(k)) q.set(k, '[redacted]')
  return `${url.slice(0, i)}?${q.toString()}`
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
      err: (e: Error) => {
        const o = pino.stdSerializers.err(e)
        return { ...o, message: maskText(o.message), stack: o.stack ? maskText(o.stack) : o.stack }
      },
      req: (r: { method?: string; url?: string; hostname?: string; host?: string; ip?: string }) => ({
        method: r.method,
        url: r.url ? redactUrl(r.url) : r.url,
        host: r.hostname ?? r.host,
        remoteAddress: r.ip,
      }),
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
