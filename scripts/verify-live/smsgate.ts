// pnpm verify:smsgate  -  walks the SMS Gate checklists of docs/integrations/smsgate.md (section 2, "Assumptions to verify on the
// real tablet", items 1-20, and section 3, "Bring-up and smoke test") against a device and writes a report.
//
// SAFE BY DEFAULT: without --send it only reads (GET /health, /messages, /webhooks, /settings) and sends nothing.
// See docs/live-verification.md for the tablet preparation and the full option list.
import { applySecretEnvironment } from '../../src/config/secrets-source.js'
import { randomUUID } from 'node:crypto'
import dns from 'node:dns/promises'
import { SmsProviderError, SmsWebhookError } from '../../src/integrations/sms/errors.js'
import { normalizeE164 } from '../../src/integrations/sms/phone.js'
import { SMSGATE_WEBHOOK_EVENTS, type SmsGateHealthBody } from '../../src/integrations/smsgate/types.js'
import { smsGateConfig } from '../../src/integrations/smsgate/config.js'
import { SmsGateProvider } from '../../src/integrations/smsgate/provider.js'
import { SimServer } from '../../src/integrations/smsgate/sim-server.js'
import { signWebhook } from '../../src/integrations/smsgate/signature.js'
import { verifyAndParse } from '../../src/integrations/smsgate/webhook.js'
import { routeInbound } from '../../src/modules/messaging/inbound/router.js'
import { systemClock } from '../../src/platform/clock.js'
import {
  MissingConfig,
  Report,
  UsageError,
  cli,
  maskPhone,
  maskUrlCredentials,
  redactDeep,
  type ItemDef,
  type RunContext,
  type RunResult,
} from './lib.js'
import { DatabaseWatcher, PROBE_KEY, tryListener, type WatchedEvent, type Watcher } from './watch.js'

const DOC2 = 'docs/integrations/smsgate.md section 2'
const DOC3 = 'docs/integrations/smsgate.md section 3 (Bring-up and smoke test)'

export const SMSGATE_ITEMS: readonly ItemDef[] = [
  {
    id: 'SG-01',
    title: 'The installed build serves /messages (OpenAPI) as well as /message',
    source: `${DOC2}, item 1`,
  },
  { id: 'SG-02', title: 'A repeated id answers 409 and does not send twice', source: `${DOC2}, item 2` },
  { id: 'SG-03', title: 'GET /messages/{unknown} is 404', source: `${DOC2}, item 3` },
  { id: 'SG-04', title: 'textMessage is accepted', source: `${DOC2}, item 4` },
  {
    id: 'SG-05',
    title: 'Ids up to 36 characters (our UUIDs and the ...r1 retry ids) are accepted',
    source: `${DOC2}, item 5`,
  },
  {
    id: 'SG-06',
    title: 'The signature is hex(HMAC-SHA256(key, rawBody + X-Timestamp)) on a real delivery',
    source: `${DOC2}, item 6`,
  },
  {
    id: 'SG-07',
    title: 'HTTPS to the tailnet name is accepted by the app and the tablet resolves it',
    source: `${DOC2}, item 7`,
  },
  {
    id: 'SG-08',
    title: 'tailscale serve --set-path strips the mount path (the target carries the full path)',
    source: `${DOC2}, item 8`,
  },
  { id: 'SG-09', title: 'Real retry count and spacing after a 5xx', source: `${DOC2}, item 9` },
  {
    id: 'SG-10',
    title: 'system:ping carries the health document at the configured interval',
    source: `${DOC2}, item 10`,
  },
  {
    id: 'SG-11',
    title: "Android's SMS limit on this tablet and what the prompt looks like",
    source: `${DOC2}, item 11`,
  },
  {
    id: 'SG-12',
    title: 'priority below 100 does not change delivery order or bypass limits',
    source: `${DOC2}, item 12`,
  },
  { id: 'SG-13', title: 'The carrier returns delivery reports', source: `${DOC2}, item 13` },
  {
    id: 'SG-14',
    title: 'sms:delivered fires once per part of a multipart message',
    source: `${DOC2}, item 14`,
  },
  { id: 'SG-15', title: 'The inbound sender format', source: `${DOC2}, item 15` },
  { id: 'SG-16', title: 'Inbound texts from RCS-capable phones reach SMS Gate', source: `${DOC2}, item 16` },
  {
    id: 'SG-17',
    title: 'The app survives sleep, the battery manager and a reboot (app:started)',
    source: `${DOC2}, item 17`,
  },
  { id: 'SG-18', title: 'The dual-SIM simNumber mapping', source: `${DOC2}, item 18` },
  { id: 'SG-19', title: 'PATCH /settings accepts webhooks.signing_key', source: `${DOC2}, item 19` },
  { id: 'SG-20', title: 'The local server answers on the tailnet interface', source: `${DOC2}, item 20` },
  { id: 'SG-B1', title: 'GET /health from the backend host answers 200', source: `${DOC3}, step 1` },
  {
    id: 'SG-B2',
    title: 'The device accepts the username and password (Basic auth)',
    source: `${DOC3}, step 2`,
  },
  { id: 'SG-B3', title: 'GET /webhooks lists the seven oasis-* registrations', source: `${DOC3}, step 3` },
  {
    id: 'SG-B4',
    title: 'One text out to the test phone, with the sent and delivered webhooks',
    source: `${DOC3}, step 4`,
  },
  {
    id: 'SG-B5',
    title: 'One text in each of C, STOP, START, HELP: the inbound router classifies them',
    source: `${DOC3}, step 5`,
  },
  {
    id: 'SG-B6',
    title: 'Two minutes without mobile data or VPN: degraded, then offline, then the backlog flushes',
    source: `${DOC3}, step 6`,
  },
  {
    id: 'SG-H1',
    title: 'Device battery and health fields',
    source: 'docs/live-verification.md (device health)',
  },
]

export const SMSGATE_OPTIONS = {
  flags: ['send', 'watch', 'replies', 'multipart', 'sync-signing-key', 'register-webhooks', 'yes'],
  options: [
    'to',
    'listen',
    'event-timeout',
    'reject',
    'sim-number',
    'measure-limit',
    'sim-port',
    'listen-port',
    'webhook-url',
    'reply-timeout',
  ],
} as const

const WEBHOOK_IDS = SMSGATE_WEBHOOK_EVENTS.map((e) => `oasis-${e.replace(/[^a-z0-9]+/gi, '-')}`)

interface Http {
  status: number
  json: unknown
  text: string
}

interface Target {
  baseUrl: string
  username: string
  password: string
  secret: string
}

function targetFromEnv(env: Record<string, string | undefined>): Target {
  const need: Array<{ name: string; why: string }> = []
  const get = (name: string, why: string): string => {
    const v = env[name]?.trim()
    if (!v) need.push({ name, why })
    return v ?? ''
  }
  const baseUrl = get(
    'SMSGATE_DEVICE_URL',
    'the tablet local server, e.g. http://100.x.y.z:8080 (SMS Gate app, Local Server; the tablet Tailscale address)',
  )
  const username = get('SMSGATE_USERNAME', 'Basic-auth user shown in the SMS Gate app under Local Server')
  const password = get('SMSGATE_PASSWORD', 'Basic-auth password shown in the SMS Gate app under Local Server')
  const secret = get(
    'SMSGATE_WEBHOOK_SECRET',
    'the signing key set in the app (Settings, Webhooks, Signing key)',
  )
  if (need.length)
    throw new MissingConfig('smsgate', need, [
      'Set them in the shell or in /etc/oasis/common.env (export $(grep -v "^#" /etc/oasis/common.env | xargs)), or run against the simulator with --sim.',
      'Tablet preparation: docs/live-verification.md, "SMS Gate".',
    ])
  try {
    new URL(baseUrl)
  } catch {
    throw new MissingConfig('smsgate', [{ name: 'SMSGATE_DEVICE_URL', why: `"${baseUrl}" is not a URL` }])
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), username, password, secret }
}

const isTailnetHost = (host: string): boolean => {
  if (host.endsWith('.ts.net')) return true
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

function segmentsOf(text: string): number {
  return text.length <= 160 ? 1 : Math.ceil(text.length / 153)
}

export async function runSmsGate(ctx: RunContext): Promise<RunResult> {
  try {
    return await runSmsGateInner(ctx)
  } catch (e) {
    if (e instanceof MissingConfig) return { missing: e }
    throw e
  }
}

async function runSmsGateInner(ctx: RunContext): Promise<RunResult> {
  const { args, env } = ctx
  const sim = args.flag('sim')
  const wantSend = args.flag('send')
  const toRaw = args.value('to')
  if (wantSend && !toRaw)
    throw new UsageError('--send needs --to <number>: nothing is sent without an explicit recipient')
  if (toRaw && !wantSend && !sim) ctx.log('note: --to is ignored without --send (read-only run)')
  const to = toRaw ? normalizeE164(toRaw) : undefined
  if (toRaw && !to) throw new UsageError(`--to "${toRaw}" is not a dialable number (use +1XXXXXXXXXX)`)
  const eventTimeoutMs = (args.number('event-timeout') ?? 90) * 1000
  const replyTimeoutMs = (args.number('reply-timeout') ?? 180) * 1000
  const wantReplies = args.flag('replies')
  if (wantReplies && !wantSend && !sim)
    throw new UsageError(
      '--replies needs --send --to (it asks the phone to reply to a text it just received)',
    )
  const measureN = args.number('measure-limit')
  if (measureN !== undefined && !(wantSend && args.flag('yes')))
    throw new UsageError('--measure-limit N sends N texts in a burst: add --send --to <number> --yes')
  if (measureN !== undefined && (measureN < 2 || measureN > 100))
    throw new UsageError('--measure-limit must be between 2 and 100')

  let simServer: SimServer | undefined
  let target: Target
  if (sim) {
    simServer = new SimServer({
      host: '127.0.0.1',
      port: args.number('sim-port') ?? 4591,
      username: 'sim',
      password: 'sim',
      signingKey: 'sim-signing-key',
      autoProgress: 'instant',
      retryDelaysMs: [150, 300, 600, 1200],
    })
    target = { baseUrl: await simServer.start(), username: 'sim', password: 'sim', secret: 'sim-signing-key' }
  } else {
    target = targetFromEnv(env)
  }

  const report = new Report(
    'smsgate',
    'SMS Gate live verification',
    SMSGATE_ITEMS,
    { mode: sim ? 'sim' : 'live', target: maskUrlCredentials(target.baseUrl) },
    ctx.now,
    ctx.log,
  )
  report.secret(target.password)
  report.secret(target.secret)
  report.secret(to ?? undefined)
  report.secret(toRaw)
  const r = report

  let watcher: Watcher | undefined
  const registeredTemp: string[] = []
  let provider: SmsGateProvider | undefined
  try {
    let messagesPath = env.SMSGATE_API_PATH?.trim() || '/messages'
    const auth = `Basic ${Buffer.from(`${target.username}:${target.password}`).toString('base64')}`
    const http = async (
      method: string,
      path: string,
      body?: unknown,
      withAuth = true,
    ): Promise<Http | { error: string }> => {
      try {
        const res = await fetch(`${target.baseUrl}${path}`, {
          method,
          headers: {
            ...(withAuth ? { authorization: auth } : {}),
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
        const text = await res.text()
        let json: unknown
        try {
          json = text ? JSON.parse(text) : undefined
        } catch {
          json = undefined
        }
        return { status: res.status, json, text }
      } catch (e) {
        return { error: (e as Error).message }
      }
    }
    const ok = (x: Http | { error: string }): x is Http => !('error' in x)

    // ---- health, reachability ------------------------------------------------------------------------------------
    const host = new URL(target.baseUrl).hostname
    const health = await http('GET', '/health', undefined, false)
    if (!ok(health)) {
      r.fail(
        'SG-B1',
        `no answer: ${health.error}`,
        'Is the tablet awake, the Local Server started, and Tailscale connected on both ends? From this host: tailscale ping <tablet>; curl -m 5 <SMSGATE_DEVICE_URL>/health',
      )
      r.fail(
        'SG-20',
        `the local server did not answer at ${host}`,
        'Check the Tailscale ACL (tag:oasis-server to tag:oasis-tablet:8080) and that the tablet app is connected.',
      )
    } else {
      const body = health.json as SmsGateHealthBody | undefined
      const level = body?.checks?.['battery:level']?.observedValue
      const plug = body?.checks?.['battery:charging']?.observedValue
      if (health.status === 200 && body && (body.status === 'pass' || body.status === 'warn')) {
        r.pass('SG-B1', `HTTP 200, status ${body.status}${body.version ? `, app ${body.version}` : ''}`)
      } else {
        r.fail(
          'SG-B1',
          `HTTP ${health.status}, status ${body?.status ?? 'unreadable'}`,
          'Open the SMS Gate app: a fail status usually means battery below 10% or no connectivity.',
          [JSON.stringify(redactDeep(body ?? health.text.slice(0, 300)))],
        )
      }
      if (isTailnetHost(host)) r.pass('SG-20', `answered on ${host} (tailnet address)`)
      else if (sim) r.pass('SG-20', `answered on ${host} (simulator on loopback)`)
      else
        r.pass(
          'SG-20',
          `answered on ${host}, which is not a 100.x or .ts.net address; confirm the path goes over Tailscale and not the shop Wi-Fi`,
        )
      if (typeof level !== 'number') {
        r.skip('SG-H1', 'the health document has no battery:level check')
      } else {
        const charging = typeof plug === 'number' ? plug > 0 : undefined
        const detail = `battery ${level}%${charging === undefined ? '' : charging ? ', charging' : ', on battery'}, health ${body?.status}`
        if (body?.status === 'fail' || (level < 25 && charging !== true))
          r.fail(
            'SG-H1',
            detail,
            'Plug the tablet in and leave it on power; the app reports warn below 25% and fail below 10%.',
          )
        else r.pass('SG-H1', detail)
      }
      if (body?.checks)
        r.note(
          `device checks: ${Object.entries(body.checks)
            .map(
              ([k, v]) =>
                `${k}=${v.status}${v.observedValue !== undefined ? `(${v.observedValue}${v.observedUnit ?? ''})` : ''}`,
            )
            .join(', ')}`,
        )
    }

    // ---- API surface: credentials, route family, unknown id ----------------------------------------------------
    const list = await http('GET', messagesPath)
    if (!ok(list)) {
      r.fail('SG-B2', `request failed: ${list.error}`)
    } else if (list.status === 401 || list.status === 403) {
      r.fail(
        'SG-B2',
        `HTTP ${list.status}: the device rejected the credentials`,
        'Re-read the username and password in the SMS Gate app (Local Server) and update SMSGATE_USERNAME / SMSGATE_PASSWORD, or the device record in Settings.',
      )
    } else if (list.status >= 200 && list.status < 300) {
      r.pass('SG-B2', 'credentials accepted')
      const other = messagesPath === '/messages' ? '/message' : '/messages'
      const alt = await http('GET', other)
      r.pass(
        'SG-01',
        `${messagesPath} answers ${list.status}${ok(alt) ? `; ${other} answers ${alt.status}` : ''}`,
      )
    } else if (list.status === 404 && messagesPath === '/messages') {
      const legacy = await http('GET', '/message')
      if (ok(legacy) && legacy.status >= 200 && legacy.status < 300) {
        messagesPath = '/message'
        r.pass('SG-B2', 'credentials accepted (on /message)')
        r.fail(
          'SG-01',
          'this build serves /message, not /messages',
          'Set SMSGATE_API_PATH=/message in the environment.',
        )
      } else {
        r.fail(
          'SG-01',
          'neither /messages nor /message answers',
          'Check the app version (release 1.77 or later) and the Local Server port.',
        )
      }
    } else {
      r.fail('SG-B2', `HTTP ${list.status} on GET ${messagesPath}`, undefined, [list.text.slice(0, 300)])
    }

    const unknown = await http('GET', `${messagesPath}/verify-live-${randomUUID().slice(0, 8)}`)
    if (!ok(unknown)) r.fail('SG-03', `request failed: ${unknown.error}`)
    else if (unknown.status === 404) r.pass('SG-03', 'an unknown id is 404')
    else
      r.fail(
        'SG-03',
        `HTTP ${unknown.status} for an unknown id`,
        'The adapter needs the not-found signal to decide a resend is safe; add the observed status to SmsGateProvider.status().',
        [unknown.text.slice(0, 200)],
      )

    // ---- webhook registry and device settings (reads) -----------------------------------------------------------
    let webhookWatchUrl: string | undefined
    const readWebhooks = async (): Promise<string[] | undefined> => {
      const w = await http('GET', '/webhooks')
      if (!ok(w) || w.status < 200 || w.status >= 300 || !Array.isArray(w.json)) return undefined
      return (w.json as Array<{ id?: string }>).map((x) => x.id ?? '')
    }

    // ---- the event source -----------------------------------------------------------------------------------------
    const showEvent = (e: WatchedEvent): void => {
      ctx.log(
        `  <- ${e.event}${typeof e.payload.messageId === 'string' ? ` ${String(e.payload.messageId).slice(0, 12)}` : ''} ${e.rejected ? `REFUSED (${e.rejected})` : e.signatureOk ? 'signature ok' : 'BAD SIGNATURE'} via ${e.via}${e.attempt > 1 ? ` attempt ${e.attempt}` : ''}`,
      )
    }
    const needWatch = args.flag('watch') || sim
    if (needWatch) {
      const listenSpec =
        args.value('listen') ??
        (sim
          ? `127.0.0.1:${args.number('listen-port') ?? 4593}`
          : `${env.HOOKS_HOST ?? '127.0.0.1'}:${env.HOOKS_PORT ?? '3002'}`)
      const [lh, lp] = [
        listenSpec.slice(0, listenSpec.lastIndexOf(':')),
        Number(listenSpec.slice(listenSpec.lastIndexOf(':') + 1)),
      ]
      if (!lh || !Number.isInteger(lp) || lp <= 0)
        throw new UsageError(`--listen "${listenSpec}" must be host:port`)
      const rejectFirst = args.number('reject')
      watcher = await tryListener({
        host: lh,
        port: lp,
        secret: target.secret,
        toleranceSec: 86_400,
        rejectFirst,
        sleep: ctx.sleep,
        onEvent: showEvent,
      })
      if (watcher) {
        r.note(
          `watching: listener on ${watcher.where}${rejectFirst ? `, refusing the first ${rejectFirst} attempt(s) of every delivery` : ''}`,
        )
      } else if (env.DATABASE_URL) {
        const db = new DatabaseWatcher({
          url: env.DATABASE_URL,
          since: new Date(ctx.now().getTime() - 5000),
          sleep: ctx.sleep,
          onEvent: showEvent,
        })
        await db.start()
        watcher = db
        r.note(
          `watching: ${listenSpec} is taken (the API owns the hooks listener), following webhook_log in the database instead`,
        )
        if (rejectFirst) r.note('--reject is ignored when following the database')
      } else {
        throw new MissingConfig('smsgate', [
          {
            name: 'DATABASE_URL',
            why: `${listenSpec} is in use (the API owns the hooks listener), so --watch can only follow webhook_log; or stop oasis-api, or pass --listen host:port`,
          },
        ])
      }
      if (watcher.kind === 'listener') {
        if (sim) {
          // The simulator plays a deployment where the API already registered its seven webhooks.
          webhookWatchUrl = `${watcher.where}/hooks/smsgate/sim-device`
          provider = new SmsGateProvider(
            smsGateConfig({
              baseUrl: target.baseUrl,
              username: target.username,
              password: target.password,
              webhookSecret: target.secret,
              messagesPath,
            }),
          )
          await provider.syncWebhooks(webhookWatchUrl, target.secret)
        } else if (args.flag('register-webhooks')) {
          const base = args.value('webhook-url') ?? env.SMSGATE_WEBHOOK_PUBLIC_URL
          if (!base)
            throw new MissingConfig('smsgate', [
              {
                name: 'SMSGATE_WEBHOOK_PUBLIC_URL',
                why: '--register-webhooks needs the HTTPS URL the tablet will post to (or --webhook-url)',
              },
            ])
          webhookWatchUrl = `${base.replace(/\/+$/, '')}/verify-live`
          const temp = new SmsGateProvider(
            smsGateConfig({
              baseUrl: target.baseUrl,
              username: target.username,
              password: target.password,
              webhookSecret: target.secret,
              messagesPath,
              webhookIdPrefix: 'oasis-verify-',
            }),
          )
          const rep = await temp.syncWebhooks(webhookWatchUrl, target.secret)
          registeredTemp.push(...rep.created, ...rep.replaced)
          r.note(
            `registered ${registeredTemp.length} temporary oasis-verify-* webhooks (removed again at the end); the production oasis-* ones are untouched`,
          )
        }
      }
    }

    // ---- registry check -------------------------------------------------------------------------------------------
    const ids = await readWebhooks()
    if (!ids) {
      r.fail('SG-B3', 'GET /webhooks failed', 'Credentials or route family: see SG-B2 and SG-01.')
    } else {
      const have = WEBHOOK_IDS.filter((i) => ids.includes(i))
      const stale = ids.filter(
        (i) => i.startsWith('oasis-') && !WEBHOOK_IDS.includes(i) && !i.startsWith('oasis-verify-'),
      )
      if (have.length === WEBHOOK_IDS.length)
        r.pass(
          'SG-B3',
          `all ${WEBHOOK_IDS.length} registered${stale.length ? `; stale: ${stale.join(', ')}` : ''}`,
        )
      else
        r.fail(
          'SG-B3',
          `${have.length} of ${WEBHOOK_IDS.length} registered (missing: ${WEBHOOK_IDS.filter((i) => !ids.includes(i)).join(', ')})`,
          'Register them: POST /api/v1/integrations/sms/devices/:id/register-webhooks (needs SMSGATE_WEBHOOK_PUBLIC_URL), or restart oasis-api, which enqueues the registration at boot.',
        )
    }

    const settings = await http('GET', '/settings')
    let pingEvery: number | undefined
    if (ok(settings) && settings.status === 200 && settings.json && typeof settings.json === 'object') {
      const s = redactDeep(settings.json) as {
        messages?: Record<string, unknown>
        ping?: { interval_seconds?: number }
      }
      pingEvery =
        typeof s.ping?.interval_seconds === 'number' && s.ping.interval_seconds > 0
          ? s.ping.interval_seconds
          : undefined
      r.note(`device settings (secrets hidden): ${JSON.stringify(s)}`)
      if (s.messages?.processing_order && s.messages.processing_order !== 'FIFO')
        r.note(
          'messages.processing_order is not FIFO: set it to FIFO in the app so a backlog drains oldest first',
        )
      if (!pingEvery)
        r.note(
          'ping.interval_seconds is not set: no system:ping webhooks (optional; health polling covers it); set 60 in the app to use them',
        )
    } else {
      r.note(
        `GET /settings was not readable (${ok(settings) ? `HTTP ${settings.status}` : settings.error}); the device settings could not be inspected`,
      )
    }

    if (args.flag('sync-signing-key')) {
      const patch = await http('PATCH', '/settings', { webhooks: { signing_key: target.secret } })
      if (ok(patch) && patch.status >= 200 && patch.status < 300)
        r.pass('SG-19', 'the device accepted webhooks.signing_key')
      else
        r.fail(
          'SG-19',
          ok(patch) ? `HTTP ${patch.status}` : patch.error,
          'Set the signing key by hand in the app and leave SMSGATE_SYNC_SIGNING_KEY=false.',
        )
    } else {
      r.skip('SG-19', 'writes the key to the device: pass --sync-signing-key to test it')
    }

    // ---- the public webhook URL, from this host ---------------------------------------------------------------
    const publicUrl = sim
      ? webhookWatchUrl?.replace(/\/[^/]+$/, '')
      : (args.value('webhook-url') ?? env.SMSGATE_WEBHOOK_PUBLIC_URL)
    let hostSideOk = false
    if (!publicUrl) {
      r.skip(
        'SG-08',
        'set SMSGATE_WEBHOOK_PUBLIC_URL (https://<host>.<tailnet>.ts.net/hooks/smsgate) so the mount can be probed',
      )
    } else {
      const u = new URL(publicUrl)
      const loopback = u.protocol === 'http:' && u.hostname === '127.0.0.1'
      if (u.protocol !== 'https:' && !loopback) {
        r.fail(
          'SG-07',
          `${maskUrlCredentials(publicUrl)} is not https`,
          'The app only accepts https:// webhook URLs (or http://127.0.0.1). Use the tailscale serve URL.',
        )
      } else {
        const resolved = await dns.lookup(u.hostname).catch((e: Error) => e)
        if (resolved instanceof Error) {
          r.fail(
            'SG-07',
            `${u.hostname} does not resolve from this host (${resolved.message})`,
            'Enable MagicDNS and HTTPS certificates in the Tailscale admin console; on this host run tailscale status.',
          )
        } else {
          try {
            const res = await fetch(`${publicUrl.replace(/\/+$/, '')}/${PROBE_KEY}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(10_000),
            })
            const body = (await res.json().catch(() => ({}))) as { status?: string }
            if (res.status === 404 && body.status === 'unknown_device') {
              hostSideOk = true
              r.pass(
                'SG-08',
                'the mount reaches the hooks handler with the path intact (probe answered unknown_device)',
              )
            } else if (res.status === 404) {
              r.fail(
                'SG-08',
                'the request arrived but the path did not match (answered not_found)',
                'tailscale serve strips the mount path: the target must carry it again, e.g. tailscale serve --set-path /hooks/smsgate http://127.0.0.1:3002/hooks/smsgate (deploy/scripts/tailscale-serve.sh does this).',
              )
            } else {
              r.fail(
                'SG-08',
                `unexpected HTTP ${res.status} from the mount`,
                'Is something other than the hooks listener behind the mount? tailscale serve status',
              )
            }
          } catch (e) {
            r.fail(
              'SG-08',
              `no answer from ${maskUrlCredentials(publicUrl)}: ${(e as Error).message}`,
              'tailscale serve status; is oasis-api running with HOOKS_PORT set (or the watch listener on that port)?',
            )
          }
        }
      }
    }

    r.note(
      'self-test of the signature scheme: ' +
        (selfTestSignature(target.secret)
          ? 'the verifier accepts a correctly signed body and rejects a tampered one'
          : 'FAILED'),
    )

    // ---- sending -----------------------------------------------------------------------------------------------
    if (!wantSend) {
      r.skip('SG-02', 'sends a text: pass --send --to <number>')
      r.skip('SG-04', 'sends a text: pass --send --to <number>')
      r.skip('SG-05', 'sends a text: pass --send --to <number>')
    } else if (to) {
      provider = new SmsGateProvider(
        smsGateConfig({
          baseUrl: target.baseUrl,
          username: target.username,
          password: target.password,
          webhookSecret: target.secret,
          messagesPath,
        }),
      )
      const stamp = ctx.now().toISOString().slice(11, 16)
      const id1 = randomUUID()
      const text1 = `Oasis Auto Spa: SMS Gate check ${stamp} UTC. No reply needed.`
      ctx.log(`sending 1 of 2 to ${maskPhone(to)} (id ${id1})`)
      let accepted1 = false
      try {
        const res = await provider.send({ id: id1, to, body: text1, ttlSec: 300, priority: 1 })
        accepted1 = true
        r.pass('SG-04', `accepted textMessage, state ${res.state}`)
      } catch (e) {
        r.fail(
          'SG-04',
          e instanceof SmsProviderError ? `${e.kind}: ${e.message}` : (e as Error).message,
          'If the device answers 400 for textMessage, set SMSGATE_LEGACY_MESSAGE_FIELD=true.',
        )
      }
      if (accepted1) {
        const dup = await http('POST', messagesPath, {
          id: id1,
          textMessage: { text: text1 },
          phoneNumbers: [to],
          withDeliveryReport: true,
        })
        if (!ok(dup)) r.fail('SG-02', `duplicate POST failed: ${dup.error}`)
        else if (dup.status === 409) r.pass('SG-02', 'the repeated id was answered 409')
        else
          r.fail(
            'SG-02',
            `the repeated id was answered ${dup.status}, not 409 (the phone may have received the text twice)`,
            'Rely on the status-first rule alone; if the device ignores ids, dedupe on (to, body, window) against GET /messages.',
          )
      } else {
        r.skip('SG-02', 'the first send failed')
      }
      const id2 = `${id1.replace(/-/g, '')}r1`
      ctx.log(`sending 2 of 2 (retry-style id ${id2.length} characters)`)
      try {
        await provider.send({
          id: id2,
          to,
          body: `Oasis Auto Spa: SMS Gate check ${stamp} UTC (2 of 2).`,
          ttlSec: 300,
          priority: 1,
        })
        if (accepted1)
          r.pass('SG-05', `accepted a ${id1.length}-character UUID and a ${id2.length}-character retry id`)
        else r.fail('SG-05', 'the retry-style id was accepted, the UUID send failed')
      } catch (e) {
        r.fail(
          'SG-05',
          `the ${id2.length}-character retry id was refused: ${(e as Error).message}`,
          'Shorten the ids in retryProviderId (src/modules/messaging).',
        )
      }

      // delivery path
      if (accepted1) {
        const gotSent = watcher
          ? await watcher.waitFor(
              (e) => e.event === 'sms:sent' && e.payload.messageId === id1,
              eventTimeoutMs,
            )
          : undefined
        const gotDelivered = watcher
          ? await watcher.waitFor(
              (e) => e.event === 'sms:delivered' && e.payload.messageId === id1,
              gotSent ? eventTimeoutMs : 1,
            )
          : undefined
        const state = await pollState(provider, id1, eventTimeoutMs, ctx)
        if (watcher) {
          if (gotSent && gotDelivered)
            r.pass('SG-B4', `sent and delivered webhooks arrived (${watcher.kind})`)
          else if (gotSent)
            r.fail(
              'SG-B4',
              `the sent webhook arrived, no delivered webhook within ${eventTimeoutMs / 1000} s (device state ${state ?? 'unknown'})`,
              'See SG-13: many carriers return no delivery reports; Oasis then treats sent as final.',
            )
          else
            r.fail(
              'SG-B4',
              `no webhook arrived within ${eventTimeoutMs / 1000} s (device state ${state ?? 'unknown'})`,
              'The text left the tablet but its webhooks did not reach us: see SG-07, SG-08 and the failure table in docs/integrations/smsgate.md.',
            )
        } else if (state === 'Sent' || state === 'Delivered') {
          r.pass('SG-B4', `device state ${state} (webhooks were not watched: add --watch)`)
        } else {
          r.fail(
            'SG-B4',
            `device state ${state ?? 'unknown'} after ${eventTimeoutMs / 1000} s`,
            'Is the SIM able to send SMS? Is a "send many messages" dialog waiting on the tablet screen?',
          )
        }
        if (state === 'Delivered' || gotDelivered) r.pass('SG-13', 'the carrier returned a delivery report')
        else if (state === 'Sent' || gotSent)
          r.fail(
            'SG-13',
            'sent, but no delivery report arrived',
            'Messages stay Sent; reconciliation stops asking after 6 h and Oasis treats sent as final. Not a defect if the carrier gives no receipts.',
          )
        else r.skip('SG-13', 'the text never reached Sent')
      }

      if (args.flag('multipart')) {
        const long = `Oasis Auto Spa multipart check. ${'0123456789 '.repeat(30)}`.slice(0, 330)
        const mid = randomUUID()
        try {
          await provider.send({ id: mid, to, body: long, ttlSec: 300, priority: 1 })
          if (watcher) {
            await watcher.waitFor(
              (e) => e.event === 'sms:delivered' && e.payload.messageId === mid,
              eventTimeoutMs,
            )
            await ctx.sleep(Math.min(3000, eventTimeoutMs / 4))
            const n = watcher.events.filter(
              (e) => e.event === 'sms:delivered' && e.payload.messageId === mid,
            ).length
            const sentEv = watcher.events.find((e) => e.event === 'sms:sent' && e.payload.messageId === mid)
            if (n > 0)
              r.pass(
                'SG-14',
                `${n} sms:delivered for a ${segmentsOf(long)}-segment text (partsCount ${String(sentEv?.payload.partsCount ?? 'n/a')})`,
              )
            else r.fail('SG-14', 'no sms:delivered arrived for the multipart text', 'See SG-13.')
          } else {
            r.skip('SG-14', 'needs --watch to count the delivered webhooks')
          }
        } catch (e) {
          r.fail('SG-14', `the multipart send failed: ${(e as Error).message}`)
        }
      } else {
        r.skip('SG-14', 'sends a 3-part text: pass --multipart (with --watch to count the webhooks)')
      }

      const simN = args.number('sim-number')
      if (simN !== undefined) {
        try {
          const sid = randomUUID()
          await provider.send({
            id: sid,
            to,
            body: `Oasis Auto Spa: SMS Gate SIM ${simN} check.`,
            simSlot: simN,
            ttlSec: 300,
            priority: 1,
          })
          r.pass(
            'SG-18',
            `the device accepted simNumber ${simN}; check on the phone that the text came from the number of SIM ${simN}`,
          )
        } catch (e) {
          r.fail(
            'SG-18',
            `simNumber ${simN} was refused: ${(e as Error).message}`,
            'Set SMSGATE_SIM_NUMBER to a slot the device has, or leave it unset for the default SIM.',
          )
        }
      } else {
        r.skip('SG-18', 'pass --sim-number <1-3> to send once through a specific SIM')
      }

      if (measureN !== undefined) await measureLimit(provider, to, measureN, ctx, r)
      else r.skip('SG-11', `sends a burst: pass --measure-limit 31 --yes. ${LIMIT_GUIDANCE}`)

      if (wantReplies) await replyFlow(ctx, r, watcher, to, replyTimeoutMs, sim, target.baseUrl)
      else r.skip('SG-B5', 'asks the phone to reply: pass --replies (with --watch)')
    }
    if (!wantSend) {
      r.skip('SG-B4', 'sends a text: pass --send --to <number> --watch')
      r.skip('SG-13', 'sends a text: pass --send --to <number> --watch')
      r.skip('SG-B5', 'needs --send --to <number> --replies --watch')
      r.skip('SG-14', 'sends a 3-part text: pass --send --to <number> --multipart --watch')
      r.skip('SG-18', 'pass --send --to <number> --sim-number <1-3>')
      r.skip('SG-11', LIMIT_GUIDANCE)
    }

    // ---- what the watcher saw (real deliveries) -----------------------------------------------------------------
    if (sim && simServer) {
      // The simulator plays the tablet for the items that otherwise need hardware or a person.
      await fetch(`${simServer.url}/__sim/ping`, { method: 'POST' })
      await fetch(`${simServer.url}/__sim/app-started`, { method: 'POST' })
      await ctx.sleep(300)
    }
    if (watcher) {
      if (watcher.events.length === 0 && !wantSend)
        await watcher.waitFor(() => true, args.number('event-timeout') ? eventTimeoutMs : 15_000)
      const good = watcher.events.filter((e) => e.signatureOk && !e.rejected?.startsWith('bad_'))
      const bad = watcher.events.filter((e) => !e.signatureOk)
      if (good.length > 0 && bad.length === 0)
        r.pass(
          'SG-06',
          `${good.length} real deliveries verified with the shared key (${[...new Set(good.map((e) => e.event))].join(', ')})`,
        )
      else if (bad.length > 0)
        r.fail(
          'SG-06',
          `${bad.length} deliveries failed verification (${[...new Set(bad.map((e) => e.rejected ?? ''))].join('; ')})`,
          'The signing key in the app differs from SMSGATE_WEBHOOK_SECRET, or the body was altered before verification. Re-set the key in the app, then capture a delivery as a fixture (docs/integrations/smsgate.md section 8).',
        )
      else r.skip('SG-06', 'no delivery arrived while watching')

      if (watcher.events.some((e) => e.signatureOk)) {
        if (publicUrl && hostSideOk && (watcher.kind === 'database' || !sim))
          r.pass('SG-07', 'the tablet delivered over the HTTPS mount (a real webhook arrived)')
        else if (sim) r.pass('SG-07', 'the simulated tablet delivered to the registered URL')
        else if (!r.has('SG-07'))
          r.skip(
            'SG-07',
            'deliveries arrived but the public URL was not probed: set SMSGATE_WEBHOOK_PUBLIC_URL',
          )
      } else if (!r.has('SG-07')) {
        r.skip(
          'SG-07',
          hostSideOk
            ? 'this host reaches the mount over HTTPS; the tablet side is proven by a delivery: use --watch while a text is sent'
            : 'needs a real delivery while watching',
        )
      }

      const pings = watcher.events.filter((e) => e.event === 'system:ping')
      if (pings.length > 0) {
        const gaps = pings
          .slice(1)
          .map((p, i) => Math.round((p.at.getTime() - pings[i]!.at.getTime()) / 1000))
        r.pass(
          'SG-10',
          `${pings.length} system:ping received${gaps.length ? `, spacing ${gaps.join('s, ')}s` : ''}${pingEvery ? ` (configured ${pingEvery}s)` : ''}`,
          [JSON.stringify(redactDeep(pings[0]!.payload)).slice(0, 600)],
        )
      } else if (pingEvery) {
        r.skip(
          'SG-10',
          `none arrived while watching; the device pings every ${pingEvery} s, so watch longer (--event-timeout ${pingEvery * 2})`,
        )
      } else {
        r.skip('SG-10', 'the device has no ping interval set (optional); health polling covers it')
      }

      const started = watcher.events.find((e) => e.event === 'app:started')
      if (started)
        r.pass(
          'SG-17',
          `app:started received (simCards: ${Array.isArray(started.payload.simCards) ? started.payload.simCards.length : 0})`,
        )
      else
        r.skip(
          'SG-17',
          'reboot the tablet while watching to observe app:started; leave it idle overnight to test the battery manager',
        )

      if (watcher.kind === 'listener' && args.number('reject')) {
        const need = (args.number('reject') ?? 0) + 1
        for (
          let waited = 0;
          waited < eventTimeoutMs && ![...watcher.attempts.values()].some((t) => t.length >= need);
          waited += 50
        )
          await ctx.sleep(50)
        const multi = [...watcher.attempts.entries()]
          .filter(([, t]) => t.length >= 2)
          .sort((a, b) => b[1].length - a[1].length)[0]
        if (multi) {
          const t = multi[1]
          const gaps = t.slice(1).map((x, i) => `${((x.getTime() - t[i]!.getTime()) / 1000).toFixed(1)}s`)
          r.pass('SG-09', `${t.length} attempts of one delivery, gaps ${gaps.join(', ')}`, [
            `envelope ${multi[0]}`,
            ...t.map((x) => x.toISOString()),
          ])
        } else {
          r.fail(
            'SG-09',
            'a refused delivery was not retried while watching',
            'Watch longer than the first retry gap (the app starts at about 5-10 s), or check the app webhook retry setting.',
          )
        }
      } else {
        r.skip(
          'SG-09',
          'pass --watch --reject 3 (listener mode) and send a text: the first 3 attempts of each delivery get a 500 and the gaps are measured',
        )
      }
    } else {
      for (const id of ['SG-06', 'SG-09', 'SG-10', 'SG-17'])
        r.skip(id, 'needs --watch (a real delivery has to arrive)')
      if (!r.has('SG-07')) r.skip('SG-07', 'needs --watch while a text is sent')
    }
    r.skip(
      'SG-12',
      'manual: pause the device, send a priority 3 then a priority 0 text, resume, and compare the order (docs/live-verification.md)',
    )
    r.skip('SG-16', r.has('SG-B5') ? 'see SG-B5' : 'needs --replies: reply from an iPhone and a Pixel')
    r.skip('SG-15', r.has('SG-B5') ? 'see SG-B5' : 'needs --replies')
    r.skip(
      'SG-B6',
      'manual: switch the tablet mobile data and VPN off for two minutes while watching the dashboard device status (docs/live-verification.md)',
    )
  } finally {
    for (const id of registeredTemp) {
      await fetch(`${target.baseUrl}/webhooks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${Buffer.from(`${target.username}:${target.password}`).toString('base64')}`,
        },
      }).catch(() => {})
    }
    await watcher?.stop()
    await simServer?.stop()
  }
  return { report }
}

const LIMIT_GUIDANCE =
  'Stock Android refuses more than 30 messages per minute per app and then shows a confirmation dialog that blocks the app until someone taps it; some vendors use 30 per 30 minutes. Oasis defaults to 30 segments per 30 minutes (SMSGATE_MAX_PER_WINDOW / SMSGATE_WINDOW_MINUTES). Measure with --measure-limit 31 --yes --to <test phone>.'

function selfTestSignature(secret: string): boolean {
  const body = JSON.stringify({
    id: 'selftest',
    deviceId: 'd',
    event: 'system:ping',
    payload: { status: 'pass' },
  })
  const ts = String(Math.floor(systemClock.now().getTime() / 1000))
  const sig = signWebhook(secret, body, ts)
  try {
    verifyAndParse({ 'x-signature': sig, 'x-timestamp': ts }, body, {
      secret,
      toleranceSec: 60,
      clock: systemClock,
    })
  } catch {
    return false
  }
  try {
    verifyAndParse({ 'x-signature': sig, 'x-timestamp': ts }, body.replace('pass', 'fail'), {
      secret,
      toleranceSec: 60,
      clock: systemClock,
    })
    return false
  } catch (e) {
    return e instanceof SmsWebhookError && e.code === 'bad_signature'
  }
}

async function pollState(
  provider: SmsGateProvider,
  id: string,
  timeoutMs: number,
  ctx: RunContext,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  let last: string | undefined
  for (;;) {
    const s = await provider.status(id).catch(() => null)
    last = s?.state ?? last
    if (last === 'Delivered' || last === 'Failed') return last
    if (Date.now() >= deadline) return last
    await ctx.sleep(Math.min(1000, Math.max(50, timeoutMs / 20)))
  }
}

async function measureLimit(
  provider: SmsGateProvider,
  to: string,
  n: number,
  ctx: RunContext,
  r: Report,
): Promise<void> {
  ctx.log(
    `burst: sending ${n} short texts to ${maskPhone(to)}; watch the tablet screen for a "send many messages" dialog and tap it away if it appears`,
  )
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = randomUUID()
    try {
      await provider.send({ id, to, body: `Oasis limit check ${i + 1}/${n}`, ttlSec: 300, priority: 1 })
      ids.push(id)
    } catch (e) {
      r.fail('SG-11', `the device refused text ${i + 1} of ${n}: ${(e as Error).message}`)
      return
    }
  }
  await ctx.sleep(
    Math.min(
      60_000,
      ctx.args.number('event-timeout') ? (ctx.args.number('event-timeout') as number) * 1000 : 60_000,
    ),
  )
  let sent = 0
  for (const id of ids) {
    const s = await provider.status(id).catch(() => null)
    if (s && s.state !== 'Pending') sent++
  }
  if (sent === n)
    r.pass(
      'SG-11',
      `${n} of ${n} left Pending within the wait: no Android prompt below ${n} texts/minute. ${n < 31 ? 'Run with 31 or more to cross the stock limit.' : 'Raise SMSGATE_MAX_PER_WINDOW only as far as measured.'}`,
    )
  else
    r.fail(
      'SG-11',
      `only ${sent} of ${n} left Pending: the tablet most likely showed the SMS limit prompt after about ${sent} texts`,
      `Keep SMSGATE_MAX_PER_WINDOW at or below ${Math.max(1, sent - 1)} per ${'minute'} until the limit is raised on the device (adb shell settings put global sms_outgoing_check_max_count ...). ${LIMIT_GUIDANCE}`,
    )
}

const REPLY_STEPS: Array<{ say: string; expect: 'confirm' | 'opt_out' | 'opt_in' | 'help' }> = [
  { say: 'C', expect: 'confirm' },
  { say: 'STOP', expect: 'opt_out' },
  { say: 'START', expect: 'opt_in' },
  { say: 'HELP', expect: 'help' },
]

async function replyFlow(
  ctx: RunContext,
  r: Report,
  watcher: Watcher | undefined,
  to: string,
  timeoutMs: number,
  sim: boolean,
  simUrl: string,
): Promise<void> {
  if (!watcher) {
    r.skip('SG-B5', 'needs --watch to see the replies arrive')
    return
  }
  const decisions: string[] = []
  const used = new Set<string>()
  let formatNote: string | undefined
  let allOk = true
  for (const step of REPLY_STEPS) {
    ctx.log(
      `>>> reply "${step.say}" from the phone ${maskPhone(to)} now (waiting up to ${Math.round(timeoutMs / 1000)} s)`,
    )
    if (sim) {
      await fetch(`${simUrl}/__sim/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: to.replace(/^\+1/, ''), message: step.say }),
      })
    }
    const ev = await watcher.waitFor(
      (e) =>
        e.event === 'sms:received' &&
        !used.has(e.envelopeId) &&
        typeof e.payload.message === 'string' &&
        e.payload.message.trim().toUpperCase() === step.say,
      timeoutMs,
    )
    if (ev) used.add(ev.envelopeId)
    if (!ev) {
      allOk = false
      decisions.push(`${step.say}: nothing arrived`)
      if (step === REPLY_STEPS[0]) {
        r.fail(
          'SG-16',
          `the reply "${step.say}" never arrived`,
          'If the phone is an iPhone or a Pixel with chat features on, the text may have gone over RCS/iMessage. Turn off "Chat features" in the Messages app on the shop SIM tablet, and test with an iPhone and an Android.',
        )
        r.fail('SG-15', 'no inbound text arrived to inspect')
      }
      continue
    }
    const raw = String(ev.payload.sender ?? ev.payload.phoneNumber ?? '')
    const normalised = normalizeE164(raw)
    if (step === REPLY_STEPS[0]) {
      const shape = /^\+\d+$/.test(raw.trim())
        ? 'E.164 with a plus'
        : /^\d{10}$/.test(raw.trim())
          ? 'bare 10 digits'
          : /^\d{11}$/.test(raw.trim())
            ? 'bare 11 digits'
            : 'another format'
      formatNote = `sender arrives as ${shape} (${maskPhone(raw)}) and normalises to ${normalised ? maskPhone(normalised) : 'nothing'}`
      if (normalised === to) r.pass('SG-15', `${formatNote}, which equals the --to number`)
      else
        r.fail(
          'SG-15',
          `${formatNote}, which is not the number the text was sent to`,
          'Extend normalizeE164 (src/integrations/sms/phone.ts) for this format.',
        )
      r.pass('SG-16', 'the first reply reached SMS Gate as an SMS')
    }
    const decision = routeInbound(
      {
        eventId: ev.envelopeId,
        deviceId: 'verify-live',
        providerMessageId: String(ev.payload.messageId ?? ''),
        from: raw,
        body: String(ev.payload.message),
        receivedAt: ev.at,
      },
      {
        now: ctx.now(),
        customer: { id: 'verify-live', firstName: 'Verify' },
        optedOut: step.expect === 'opt_in',
        appointments: [
          { id: 'verify-appt', status: 'booked', start: new Date(ctx.now().getTime() + 3 * 3600_000) },
        ],
        timeZone: 'America/New_York',
      },
    )
    if (decision.kind === step.expect) decisions.push(`${step.say}: ${decision.kind}`)
    else {
      allOk = false
      decisions.push(`${step.say}: routed as ${decision.kind}, expected ${step.expect}`)
    }
  }
  if (allOk) r.pass('SG-B5', decisions.join('; '))
  else
    r.fail(
      'SG-B5',
      decisions.join('; '),
      'Fix the sender format or keyword handling shown above; keywords are the whole message, case-insensitive (src/modules/messaging/inbound/keywords.ts).',
    )
}

export const HELP = `pnpm verify:smsgate [options]

Walks the SMS Gate checklists (docs/integrations/smsgate.md sections 2 and 3) and writes docs/live-verification/<date>-smsgate.md and .json.
Read-only unless --send is given. Exit code 0 = no FAIL, 1 = at least one FAIL, 2 = configuration missing or bad command line.

Environment (or --sim): SMSGATE_DEVICE_URL SMSGATE_USERNAME SMSGATE_PASSWORD SMSGATE_WEBHOOK_SECRET
Optional environment: SMSGATE_WEBHOOK_PUBLIC_URL SMSGATE_API_PATH HOOKS_HOST HOOKS_PORT DATABASE_URL

  --sim                    run against the built-in simulator (port 4591, --sim-port) and play the tablet and the person
  --send --to +1XXXXXXXXXX send two texts to that number (the only way anything is sent); also tests duplicate ids
  --watch                  follow webhook deliveries live: listen on HOOKS_HOST:HOOKS_PORT (stop oasis-api first), or --listen host:port;
                           when that port is taken and DATABASE_URL is set, follow webhook_log instead
  --event-timeout SECONDS  how long to wait for each webhook (default 90)
  --replies                ask for replies C, STOP, START, HELP from the phone and route them (needs --send --watch)
  --reply-timeout SECONDS  wait per reply (default 180)
  --multipart              also send a 3-part text and count the sms:delivered webhooks
  --sim-number N           also send once through SIM slot N
  --measure-limit N --yes  send N texts in a burst to find the Android prompt threshold (use 31)
  --reject N               listener mode: answer 500 to the first N attempts of each delivery to measure the retry schedule
  --register-webhooks      listener mode against a real device: add temporary oasis-verify-* webhooks pointing at --webhook-url, removed afterwards
  --sync-signing-key       PATCH the signing key onto the device (writes device settings)
  --webhook-url URL        public HTTPS base to probe (default SMSGATE_WEBHOOK_PUBLIC_URL)
  --out-dir DIR            where reports go (default docs/live-verification)
  --json                   also print the JSON summary
`

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log: (l: string) => void = console.log,
): Promise<number> {
  return cli('verify:smsgate', HELP, argv, runSmsGate, SMSGATE_OPTIONS, env, log)
}

if (process.argv[1] && process.argv[1].endsWith('smsgate.ts')) {
  // the settings may live in the Secrets Manager secret (OASIS_SECRET_ID), like the app's
  applySecretEnvironment().then(
    () => main(process.argv.slice(2)).then((c) => process.exit(c)),
    (e: unknown) => {
      console.error((e as Error).message)
      process.exit(2)
    },
  )
}
