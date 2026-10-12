// pnpm eval:conversations  -  the live conversation eval (ADR 0160 W4b): the personas of test/assistant/fixtures/personas.json run
// IN-PROCESS through the real runtime, the same composition the worker uses (the SMS Gate webhook, the gate, the welcome flow and the
// conversation marker, AssistantRuntime.respond: the turn, the tool registry, the shop facts, the output guard v4 and the policy judge,
// the reply-number handler, the leads), against a fresh schema in the LOCAL TEST database (DATABASE_URL_TEST of .env), with the
// simulated SMS device (every outbound text is captured as the phone would show it) and a frozen clock moved between texts.
// Settings as production will have them: the `catalog` seed (+ `website-catalog` for the seeded run, the current production state
// without it), assistant.enabled, stage everyone, actions on. The AI_* switches on, PUBLIC_LINKS_ENABLED on.
//
// AI_PROVIDER=bedrock calls the assistant and its policy judge (AI_BEDROCK_MODEL_ID, default Sonnet 4.6), the client simulator (the
// same model) and the quality judge (Opus 4.6) on Bedrock with the default credential chain. On oasis-app run it with the operator
// profile (never instance metadata), one eval process at a time:
//   AWS_PROFILE=oasis-setup AWS_EC2_METADATA_DISABLED=true AWS_REGION=us-east-1 AI_PROVIDER=bedrock \
//     AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6 pnpm eval:conversations --budget-usd 12 --json out.json
// AI_PROVIDER=sim (the default) never reaches AWS (the suite's harness test).
//
// Options: --personas <path>, --only id,id, --category c,c, --catalog seeded|unseeded|both (unseeded runs the personas marked
// `unseeded`, or every --only one), --concurrency <n> (default 2: one schema per worker), --budget-usd <n> (default 25: no new
// conversation starts once the spend, the eval's own calls included, reaches it), --no-quality, --json <path> (every result and
// transcript), --transcripts <path> (markdown transcripts), --rpm <n> (calls a minute to the assistant's model, default 40: the
// account's quota is 50 and shared with every other eval: run one at a time). Prints one row per persona and the totals against
// the plan's targets.
// Exit 0 when it ran (the numbers are for people to read), 2 on a usage or settings error.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'kysely'
import { runSeed } from '../db/seeds/index.js'
import { SIM_DEVICE_KEY, SIM_WEBHOOK_SECRET } from '../db/seeds/messaging.js'
import { loadEnv, type Env } from '../src/config/env.js'
import { schedulingPortsFor } from '../src/composition.js'
import { aiCostMicros, createAiProvider, findClaudeModel, highestListPrices, type AiPrices } from '../src/integrations/ai/index.js'
import { textOf, type AiProvider, type AiUsage } from '../src/integrations/ports/ai.js'
import { signWebhook } from '../src/integrations/smsgate/signature.js'
import {
  checkConversation,
  formatReport,
  parsePersonas,
  parseQualityVerdict,
  QUALITY_MODEL,
  QUALITY_RUBRIC,
  qualityPrompt,
  renderTranscript,
  type ConversationRun,
  type EvalMessage,
  type EvalTurn,
  type Persona,
  type PersonaResult,
  type QualityVerdict,
} from '../src/modules/assistant/convo-eval.js'
import { placeholderValues, renderShopFacts } from '../src/modules/assistant/facts.js'
import { parseVerdict } from '../src/modules/assistant/judge.js'
import { INTAKE_LINES } from '../src/modules/assistant/prompt.js'
import { AssistantRuntime } from '../src/modules/assistant/runtime.js'
import { grantTrust } from '../src/modules/identity/trust.js'
import { grantCycleCredits } from '../src/modules/memberships/credits.js'
import { ensurePlans, loadPlans } from '../src/modules/memberships/plans.js'
import { hasActiveOptOut } from '../src/modules/messaging/db/recipients.js'
import { MessagingRuntime } from '../src/modules/messaging/runtime.js'
import { addMonths } from '../src/modules/payments-sync/membership.js'
import { FixedClock } from '../src/platform/clock.js'
import { createDb, type Db, type DbOptions } from '../src/platform/db.js'
import { createIdGenerator, type NewId } from '../src/platform/ids.js'
import { migrateUp } from '../src/platform/migrate.js'
import { formatPhoneDisplay } from '../src/platform/phone.js'
import { performance } from 'node:perf_hooks'

export const DEFAULT_PERSONAS = 'test/assistant/fixtures/personas.json'
const SEEDED_PROFILES = 'people,catalog,website-catalog,messaging'
const UNSEEDED_PROFILES = 'people,catalog,messaging'
/** The shop's numbers as the runtime e2e uses them (the texting line is where the clients text to). */
const BUSINESS_PHONE = '+12015986304'
const BUSINESS_TEXT_NUMBER = '+18623885827'
const UK_NUMBER = '+447700900123'
/**
 * The account's Sonnet 4.6 quota is 50 requests a minute (cross-region; W4a): every call of the assistant's model counts, the policy
 * judge's and the client simulator's too. The eval paces itself below it BETWEEN turns (a turn starts only when the last minute's
 * calls plus a turn's worth for every running turn stay under --rpm), so a turn's measured latency never includes the eval's wait.
 */
export const DEFAULT_RPM = 40
/** The most model calls one turn makes (4 tool rounds, the reply, a rewrite) plus its judge calls. */
const CALLS_PER_TURN = 7

/** Paces the turns below a calls-a-minute budget (see DEFAULT_RPM). */
export class RpmGate {
  private stamps: number[] = []
  private inflight = 0
  constructor(
    readonly rpm: number,
    readonly perTurn: number,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  record(): void {
    this.stamps.push(this.now())
  }
  /** Calls in the last minute. */
  recent(): number {
    const since = this.now() - 60_000
    this.stamps = this.stamps.filter((t) => t > since)
    return this.stamps.length
  }
  async enter(): Promise<void> {
    // at least one turn may always run (a budget below one turn would wait forever)
    while (this.inflight > 0 && this.recent() + (this.inflight + 1) * this.perTurn > this.rpm) await this.sleep(250)
    while (this.inflight === 0 && this.recent() + this.perTurn > this.rpm) await this.sleep(250)
    this.inflight += 1
  }
  leave(): void {
    this.inflight = Math.max(0, this.inflight - 1)
  }
}

export interface EvalConversationsOptions {
  personas: string
  only: string[] | null
  categories: string[] | null
  catalog: 'seeded' | 'unseeded' | 'both'
  concurrency: number
  budgetUsd: number
  quality: boolean
  json: string | null
  transcripts: string | null
  /** Calls a minute to the assistant's model (assistant, policy judge, client simulator): the account's quota is shared. */
  rpm: number
}

export function parseArgs(argv: readonly string[]): EvalConversationsOptions {
  const o: EvalConversationsOptions = { personas: DEFAULT_PERSONAS, only: null, categories: null, catalog: 'seeded', concurrency: 2, budgetUsd: 25, quality: true, json: null, transcripts: null, rpm: DEFAULT_RPM }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--personas') o.personas = value()
    else if (a === '--only') o.only = value().split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--category') o.categories = value().split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--catalog') {
      const v = value()
      if (v !== 'seeded' && v !== 'unseeded' && v !== 'both') throw new Error('--catalog is seeded, unseeded or both')
      o.catalog = v
    } else if (a === '--concurrency') o.concurrency = Math.max(1, Math.min(6, Number.parseInt(value(), 10) || 1))
    else if (a === '--budget-usd') o.budgetUsd = Math.max(0, Number(value()) || 0)
    else if (a === '--no-quality') o.quality = false
    else if (a === '--json') o.json = value()
    else if (a === '--transcripts') o.transcripts = value()
    else if (a === '--rpm') o.rpm = Math.max(1, Number.parseInt(value(), 10) || DEFAULT_RPM)
    else if (a !== '--') throw new Error(`unknown option ${a}`)
  }
  return o
}

/** The models of one run. Built from the environment by default; the suite passes simulators. */
export interface EvalProviders {
  assistant: AiProvider
  judge: AiProvider
  /** Opus 4.6 (null: no quality rating). */
  quality: AiProvider | null
  /** The client simulator (null: the simulated personas are skipped). */
  simulator: AiProvider | null
}

export interface EvalDeps {
  providers?: EvalProviders
  /** The schema names' prefix (one schema per worker). */
  schemaPrefix?: string
  log?: (line: string) => void
  /** Extra environment for the runtime (the suite shortens nothing; kept for experiments). */
  env?: Record<string, string>
}

function databaseUrl(): string {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.DATABASE_URL_TEST
  if (!url) throw new Error('DATABASE_URL_TEST is not set (the local test database, from .env)')
  return url
}

/** The persona's phones: a US mobile number of the 555-01xx range (or the +44 number) and a second one for the wrong-phone case. */
export function phonesOf(index: number, persona: Persona): { primary: string; alt: string } {
  const n = String(100 + (index % 100)).padStart(4, '0')
  return { primary: persona.phone === 'uk' ? UK_NUMBER : `+1201555${n}`, alt: `+1973555${n}` }
}

/** One worker: its own schema, frozen clock and runtimes. */
class EvalWorld {
  db!: Db
  connection!: DbOptions
  rt: MessagingRuntime | null = null
  locationId = ''
  readonly clock = new FixedClock('2026-10-14T10:00:00-04:00')
  readonly newId: NewId = createIdGenerator(this.clock)
  private seq = 0
  constructor(
    readonly schema: string,
    readonly url: string,
  ) {}

  async open(): Promise<void> {
    const admin = createDb({ url: this.url, poolMax: 1 })
    try {
      await sql`drop schema if exists ${sql.id(this.schema)} cascade`.execute(admin)
    } finally {
      await admin.destroy()
    }
    await migrateUp({ url: this.url }, { schema: this.schema, clock: this.clock })
    this.connection = { url: this.url, searchPath: `${this.schema},public`, clock: this.clock, poolMax: 6, applicationName: 'oasis-eval-conversations' }
    this.db = createDb(this.connection)
  }

  async close(drop: boolean): Promise<void> {
    await this.rt?.idle()
    await this.db.destroy()
    if (drop) {
      const admin = createDb({ url: this.url, poolMax: 1 })
      try {
        await sql`drop schema if exists ${sql.id(this.schema)} cascade`.execute(admin)
      } finally {
        await admin.destroy()
      }
    }
  }

  /** A fresh shop for one persona: every table emptied, the seeds of the catalog run, the assistant's settings on. */
  async reset(o: { profiles: string; startAt: string; faq: Array<{ q: string; a: string }> }): Promise<void> {
    await this.rt?.idle()
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = ${this.schema} and tablename <> 'schema_migrations'`.execute(this.db)
        if (r.rows.length > 0) await sql`truncate table ${sql.join(r.rows.map((x) => sql.id(x.tablename)))} restart identity cascade`.execute(this.db)
        break
      } catch (e) {
        if ((e as { code?: string }).code !== '40P01' || attempt >= 5) throw e
      }
    }
    this.clock.set(o.startAt)
    await runSeed({ db: this.db, clock: this.clock, profile: o.profiles })
    this.locationId = (await this.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
    // logins for the employees, so managers exist for the handoff notices (as in production)
    await sql`insert into users (id, employee_id, email, password_hash)
      select gen_random_uuid(), e.id, lower(e.first) || '@example.test', 'not-a-real-hash' from employees e
      where not exists (select 1 from users u where u.employee_id = e.id)`.execute(this.db)
    await this.setting('assistant.enabled', true)
    await this.setting('assistant.stage', 'everyone')
    await this.setting('assistant.actions_enabled', true)
    if (o.faq.length > 0) {
      const current = (await this.db.selectFrom('settings').select('value').where('location_id', '=', this.locationId).where('key', '=', 'assistant.faq').executeTakeFirst())?.value
      await this.setting('assistant.faq', [...(Array.isArray(current) ? current : []), ...o.faq])
    }
  }

  async setting(key: string, value: unknown): Promise<void> {
    await sql`insert into settings (location_id, key, value) values (${this.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(this.db)
  }

  runtime(env: Env): MessagingRuntime {
    const holder: { rt?: MessagingRuntime } = {}
    const rt = new MessagingRuntime({
      db: this.db,
      clock: this.clock,
      newId: this.newId,
      env,
      connection: this.connection,
      simAutoProgress: 'instant',
      schedulingPorts: () => schedulingPortsFor({ db: this.db, clock: this.clock, env, newId: this.newId }, holder.rt!),
    })
    holder.rt = rt
    this.rt = rt
    return rt
  }

  /** A text from the client's phone through the signed SMS Gate webhook, as the tablet delivers it. */
  async inbound(from: string, text: string): Promise<void> {
    this.seq += 1
    const id = `evt-${this.seq}-${this.newId().slice(-8)}`
    const payload = { messageId: `eval-in-${this.seq}-${this.newId().slice(-6)}`, sender: from, recipient: BUSINESS_TEXT_NUMBER, simNumber: 1, message: text, receivedAt: this.clock.now().toISOString() }
    const body = JSON.stringify({ id, webhookId: 'oasis-sms-received', event: 'sms:received', deviceId: 'remote-device-1', payload })
    const ts = String(Math.floor(this.clock.now().getTime() / 1000))
    await this.rt!.webhooks.receive(SIM_DEVICE_KEY, { 'x-signature': signWebhook(SIM_WEBHOOK_SECRET, body, ts), 'x-timestamp': ts, 'content-type': 'application/json' }, body)
    await this.rt!.idle()
  }
}

/** The client on file of a persona (an existing client of the shop): the record, vehicles, membership, visits and the phone trust. */
async function setupClient(w: EvalWorld, p: Persona, phone: string): Promise<string | null> {
  const c = p.client
  if (!c) return null
  const now = w.clock.now()
  const id = w.newId()
  await w.db
    .insertInto('customers')
    .values({
      id,
      full_name: c.name,
      phone_e164: phone,
      phone_display: formatPhoneDisplay(phone),
      email: null,
      notes: null,
      sms_opted_in: true,
      sms_opt_in_source: 'online',
      sms_opt_in_at: new Date(now.getTime() - 90 * 86_400_000),
      source: 'online',
      synthetic: true,
      created_at: new Date(now.getTime() - 90 * 86_400_000),
    } as never)
    .execute()
  for (const v of c.vehicles)
    await w.db.insertInto('vehicles').values({ id: w.newId(), customer_id: id, make: v.make, model: v.model, year: v.year, vehicle_type: v.type } as never).execute()
  if (c.membership) {
    const d = { locationId: w.locationId, clock: w.clock, newId: w.newId }
    await ensurePlans(w.db, d)
    const plan = (await loadPlans(w.db, w.locationId)).find((x) => x.key === (c.membership === 'gold' ? 'premium' : 'executive'))
    if (plan) {
      const mid = w.newId()
      const start = new Date(now.getTime() - 10 * 86_400_000)
      await w.db
        .insertInto('memberships')
        .values({
          id: mid,
          location_id: w.locationId,
          customer_id: id,
          plan_id: plan.id,
          plan_label: c.membership === 'gold' ? 'Gold' : 'VIP',
          status: 'active',
          source: 'manual',
          started_at: addMonths(start, -3),
          current_period_start: start,
          current_period_end: addMonths(start, 1),
          manual_status_at: now,
          created_at: now,
          updated_at: now,
        } as never)
        .execute()
      await grantCycleCredits(w.db, d, { id: mid, currentPeriodStart: start }, plan, 'Eval')
    }
  }
  for (const a of c.appointments) {
    const svc =
      (a.service
        ? await w.db
            .selectFrom('services')
            .select(['id', 'name', 'price_cents', 'duration_min'])
            .where(sql<boolean>`lower(name) = ${a.service.toLowerCase()}`)
            .where('kind', '=', 'package')
            .executeTakeFirst()
        : undefined) ??
      (await w.db.selectFrom('services').select(['id', 'name', 'price_cents', 'duration_min']).where('kind', '=', 'package').where('active', '=', true).orderBy('sort').executeTakeFirstOrThrow())
    const start = new Date(now.getTime() + a.inMinutes * 60_000)
    await w.db
      .insertInto('appointments')
      .values({
        id: w.newId(),
        location_id: w.locationId,
        customer_id: id,
        service_id: svc.id,
        package_name: svc.name,
        price_cents: svc.price_cents,
        duration_min: svc.duration_min,
        status: 'booked',
        scheduled_start: start,
        scheduled_end: new Date(start.getTime() + svc.duration_min * 60_000),
        created_at: new Date(now.getTime() - 5 * 86_400_000),
      } as never)
      .execute()
  }
  if (c.trusted) await w.db.transaction().execute((tx) => grantTrust(tx, { locationId: w.locationId, phone, customerId: id, verifiedBy: 'pin', now: new Date(now.getTime() - 86_400_000) }))
  return id
}

const LINK_KINDS: Record<string, string> = { c: 'calendar', m: 'membership', p: 'pay', pin: 'pin', v: 'verify' }

interface Tally {
  usd: number
}

function usageCost(usage: AiUsage, prices: AiPrices): number {
  return aiCostMicros(usage, prices)
}

const SIMULATOR_RULES = `You role-play a client texting a car wash / auto spa's text line, to test its automated assistant. Write ONLY the client's next text message: short and natural like a real SMS (often lowercase, no sign-off), in the persona's language. Pursue your goal; react to what the assistant actually said. Rules of the game:
- If the shop texted you a confirmation number ("Reply 1234 to confirm") and you want that, reply with just that number.
- If the shop sent you a secure verify link and you would open it, reply exactly [VERIFIED] (it means you opened it and confirmed it is you).
- When your goal is reached, the conversation is clearly over, or you would stop texting, reply exactly [DONE].
- Never write anything but the text itself.`

async function simulatorText(provider: AiProvider, persona: Persona, transcript: string, prices: AiPrices, tally: Tally): Promise<{ text: string; costMicros: number }> {
  const res = await provider.converse({
    system: [{ text: SIMULATOR_RULES }],
    messages: [{ role: 'user', content: [{ type: 'text', text: `PERSONA: ${persona.description}\nGOAL: ${persona.simulate!.goal}\n\nCONVERSATION SO FAR:\n${transcript || '(nothing yet: write your first text)'}\n\nYour next text:` }] }],
    maxTokens: 200,
    temperature: 0.7,
  })
  const cost = usageCost(res.usage, prices)
  tally.usd += cost / 1e6
  return { text: textOf(res.message).trim().replace(/^"|"$/g, ''), costMicros: cost }
}

/** Runs one persona through the runtime and returns the finished conversation. */
async function runPersona(
  w: EvalWorld,
  persona: Persona,
  o: { index: number; catalog: 'seeded' | 'unseeded'; startAt: string; envBase: Record<string, string>; providers: EvalProviders; tally: Tally; simPrices: AiPrices; gate: RpmGate },
): Promise<{ run: ConversationRun; factsText: string; evalCostMicros: number }> {
  const phones = phonesOf(o.index, persona)
  await w.reset({ profiles: o.catalog === 'seeded' ? SEEDED_PROFILES : UNSEEDED_PROFILES, startAt: persona.startAt ?? o.startAt, faq: persona.faq })
  const env = loadEnv({ ...o.envBase, SMS_ALLOWLIST: [phones.primary, phones.alt].join(',') })
  const rt = w.runtime(env)
  const art = new AssistantRuntime({ db: w.db, clock: w.clock, newId: w.newId, env, messaging: rt, provider: o.providers.assistant, judgeProvider: o.providers.judge })
  rt.useAssistant(art.ports())
  const customerId = await setupClient(w, persona, phones.primary)
  if (persona.optedOut)
    await w.db
      .insertInto('sms_opt_outs')
      .values({ id: w.newId(), location_id: w.locationId, phone_e164: phones.primary, opted_out_at: new Date(w.clock.now().getTime() - 86_400_000), source: 'keyword', keyword: 'STOP', inbound_message_id: null, opted_out_by: null, opted_in_again_at: null })
      .execute()
  const facts = await art.deps.facts.get(w.locationId)
  const factsText = renderShopFacts(facts)
  const renderedPhrases = [...placeholderValues(facts).entries()].filter(([k]) => !k.startsWith('{balance')).map(([, v]) => v)

  const messages: EvalMessage[] = []
  const turnSteps = new Map<string, number>()
  const handoffs: string[] = []
  const seen = new Set<string>()
  let seq = 0
  let optedOutAfterSeq: number | null = null
  let lastCode: string | null = null
  let evalCostMicros = 0
  let error: string | null = null
  const apptBefore = new Map(
    (await w.db.selectFrom('appointments').select(['id', 'status', 'scheduled_start']).where('customer_id', '=', customerId ?? '00000000-0000-0000-0000-000000000000').execute()).map((a) => [a.id, a]),
  )
  let handoffState: string | null = null

  const capture = async (step: number): Promise<void> => {
    const rows = await w.db
      .selectFrom('messages as m')
      .leftJoin('sms_outbox as o', 'o.message_id', 'm.id')
      .select(['m.id', 'm.body', 'm.klass', 'm.template_key', 'm.sender_kind', 'm.peer_e164', 'o.body as real'])
      .where('m.direction', '=', 'out')
      .where('m.peer_e164', 'in', [phones.primary, phones.alt])
      .orderBy('m.queued_at')
      .orderBy('m.id')
      .execute()
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      const real = r.real && r.real.length > 0 ? r.real : r.body
      const links: string[] = []
      const text = real.replace(/https?:\/\/[^\s]+\/#\/(c|m|p|pin|v)\/[A-Za-z0-9_-]+/g, (_, k: string) => {
        links.push(LINK_KINDS[k] ?? k)
        return `[link:${LINK_KINDS[k] ?? k}]`
      })
      const code = /Reply (\d{4,8}) to confirm/.exec(real)?.[1]
      if (code && r.peer_e164 === phones.primary) lastCode = code
      seq += 1
      messages.push({ seq, step, dir: 'out', phone: r.peer_e164 === phones.alt ? 'alt' : 'primary', text, klass: r.klass, templateKey: r.template_key, senderKind: r.sender_kind, links })
      if (r.template_key === 'opt_out_confirm' && optedOutAfterSeq === null) optedOutAfterSeq = seq
    }
  }
  const respond = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      const c = await w.db.selectFrom('assistant_conversations').select(['id', 'pending_since']).where('phone_e164', '=', phones.primary).executeTakeFirst()
      if (!c?.pending_since) return
      const before = new Set((await w.db.selectFrom('assistant_turns').select('id').where('conversation_id', '=', c.id).execute()).map((t) => t.id))
      await o.gate.enter()
      try {
        await art.respond(c.id)
      } finally {
        o.gate.leave()
      }
      for (const t of await w.db.selectFrom('assistant_turns').select('id').where('conversation_id', '=', c.id).execute()) if (!before.has(t.id)) turnSteps.set(t.id, currentStep)
    }
  }
  let currentStep = 0
  const afterStep = async (lastInboundSeq: number): Promise<void> => {
    await capture(currentStep)
    // deliver what was queued (the simulated tablet), so the next turn reads the conversation as production would
    await rt.tickAll()
    const c = await w.db.selectFrom('assistant_conversations').select(['handoff_state', 'handoff_reason']).where('phone_e164', '=', phones.primary).executeTakeFirst()
    if (c?.handoff_state === 'open' && handoffState !== 'open') handoffs.push(c.handoff_reason ?? 'open')
    handoffState = c?.handoff_state ?? null
    if (optedOutAfterSeq === null && (await hasActiveOptOut(w.db, w.locationId, phones.primary)) && !persona.optedOut) optedOutAfterSeq = lastInboundSeq
  }
  const send = async (text: string, from: 'primary' | 'alt', afterMin: number, burst: string[] | null): Promise<void> => {
    w.clock.advance(Math.round(afterMin * 60_000))
    const texts = burst ?? [text]
    let last = 0
    for (const [i, t0] of texts.entries()) {
      if (i > 0) w.clock.advance(2_000)
      const t = t0.replace(/\{\{code\}\}/g, lastCode ?? '0000')
      seq += 1
      last = seq
      messages.push({ seq, step: currentStep, dir: 'in', phone: from, text: t, klass: null, templateKey: null, senderKind: null, links: [] })
      await w.inbound(from === 'alt' ? phones.alt : phones.primary, t)
    }
    // the job's debounce: the turn starts once the newest text is AI_DEBOUNCE_MS old
    w.clock.advance(env.AI_DEBOUNCE_MS + 500)
    await respond()
    await afterStep(last)
  }

  try {
    for (const step of persona.steps) {
      currentStep += 1
      if ('verify' in step) {
        const owner = await w.db.selectFrom('customers').select('id').where('phone_e164', '=', phones.primary).where('deleted_at', 'is', null).executeTakeFirst()
        if (owner) await w.db.transaction().execute((tx) => grantTrust(tx, { locationId: w.locationId, phone: phones.primary, customerId: owner.id, verifiedBy: 'code', now: w.clock.now() }))
        continue
      }
      if ('burst' in step) await send('', 'primary', step.afterMin, step.burst)
      else await send(step.text, step.from, step.afterMin, null)
    }
    if (persona.simulate && o.providers.simulator) {
      for (let i = 0; i < persona.simulate.maxTurns; i++) {
        currentStep += 1
        const partial: ConversationRun = { ...emptyRun(persona, o.catalog), messages }
        await o.gate.enter()
        const s = await simulatorText(o.providers.simulator, persona, renderTranscript(partial), o.simPrices, o.tally).finally(() => o.gate.leave())
        evalCostMicros += s.costMicros
        if (s.text === '' || s.text.includes('[DONE]')) break
        if (s.text.includes('[VERIFIED]')) {
          const verifySent = messages.some((m) => m.links.includes('verify'))
          const owner = await w.db.selectFrom('customers').select('id').where('phone_e164', '=', phones.primary).where('deleted_at', 'is', null).executeTakeFirst()
          if (verifySent && owner) await w.db.transaction().execute((tx) => grantTrust(tx, { locationId: w.locationId, phone: phones.primary, customerId: owner.id, verifiedBy: 'code', now: w.clock.now() }))
          await send('Done, I verified on the link.', 'primary', 2, null)
          continue
        }
        await send(s.text.slice(0, 400), 'primary', 1, null)
      }
    }
  } catch (e) {
    error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300)
  }
  await rt.idle()

  // the turns (latency, cost, judge verdicts), the intake lines, the appointment changes
  const convIds = (await w.db.selectFrom('assistant_conversations').select('id').where('phone_e164', 'in', [phones.primary, phones.alt]).execute()).map((c) => c.id)
  const turnRows = convIds.length
    ? await w.db
        .selectFrom('assistant_turns')
        .select(['id', 'status', 'error', 'latency_ms', 'cost_micros', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write', 'rounds', 'model', 'transcript'])
        .where('conversation_id', 'in', convIds)
        .orderBy('started_at')
        .orderBy('id')
        .execute()
    : []
  const judgeRows = turnRows.length
    ? await w.db.selectFrom('assistant_tool_calls').select(['turn_id', 'outcome', 'error', 'input', 'output']).where('turn_id', 'in', turnRows.map((t) => t.id)).where('tool', '=', 'policy_judge').orderBy('seq').execute()
    : []
  const turns: EvalTurn[] = turnRows.map((t) => ({
      step: turnSteps.get(t.id) ?? 0,
      status: t.status,
      error: t.error,
      latencyMs: t.latency_ms ?? 0,
      costMicros: Number(t.cost_micros ?? 0),
      tokensIn: t.tokens_in ?? 0,
      tokensOut: t.tokens_out ?? 0,
      cacheRead: t.tokens_cache_read ?? 0,
      cacheWrite: t.tokens_cache_write ?? 0,
      rounds: t.rounds ?? 0,
      judge: judgeRows.filter((j) => j.turn_id === t.id).map((j) => (j.outcome === 'ok' ? 'pass' : j.outcome === 'denied' ? `fail:${j.error}` : 'error')),
      trace: traceOf(t.transcript, judgeRows.filter((j) => j.turn_id === t.id)),
      fallback: (t.status === 'failed' || t.status === 'handed_off') && t.error !== 'stale',
    }))
  const intake: string[] = []
  let firstContext: string | null = null
  for (const t of turnRows) {
    const entries = (typeof t.transcript === 'string' ? JSON.parse(t.transcript) : t.transcript) as Array<{ kind: string; text?: string }> | null
    const ctx = entries?.find((e) => e.kind === 'context')?.text ?? ''
    firstContext ??= ctx || null
    const line = /^Intake: (.*)\.$/m.exec(ctx)?.[1]
    intake.push(line ? (Object.entries(INTAKE_LINES).find(([, v]) => v === line)?.[0] ?? '?') : '-')
  }
  const owners = (await w.db.selectFrom('customers').select('id').where('phone_e164', 'in', [phones.primary, phones.alt]).execute()).map((c) => c.id)
  const appointmentChanges: ConversationRun['appointmentChanges'] = []
  if (owners.length > 0) {
    const executed = await w.db.selectFrom('assistant_pending_actions').select(['kind']).where('customer_id', 'in', owners).where('state', '=', 'executed').execute()
    const left = { book: executed.filter((x) => x.kind === 'book').length, cancel: executed.filter((x) => x.kind === 'cancel').length, reschedule: executed.filter((x) => x.kind === 'reschedule').length }
    for (const a of await w.db.selectFrom('appointments').select(['id', 'status', 'scheduled_start', 'source']).where('customer_id', 'in', owners).orderBy('created_at').execute()) {
      const was = apptBefore.get(a.id)
      const kind = !was ? 'created' : was.status !== 'canceled' && a.status === 'canceled' ? 'canceled' : was.scheduled_start.getTime() !== a.scheduled_start.getTime() ? 'rescheduled' : null
      if (!kind) continue
      const key = kind === 'created' ? 'book' : kind === 'canceled' ? 'cancel' : 'reschedule'
      const via = left[key] > 0
      if (via) left[key] -= 1
      appointmentChanges.push({ kind, viaReplyNumber: via, source: (a as { source?: string | null }).source ?? null })
    }
  }
  return {
    run: { personaId: persona.id, category: persona.category, catalog: o.catalog, messages, turns, handoffs, optedOutAfterSeq, appointmentChanges, renderedPhrases, intake, firstContext, error },
    factsText,
    evalCostMicros,
  }
}

/** The turn as compact lines for review: the model's drafts and tool calls, the guard's and the judge's verdicts (what it read). */
function traceOf(transcript: unknown, judges: Array<{ outcome: string; error: string | null; input: unknown; output: unknown }>): string[] {
  const entries = (typeof transcript === 'string' ? JSON.parse(transcript) : transcript) as Array<Record<string, unknown>> | null
  const out: string[] = []
  let j = 0
  const short = (v: unknown, n = 300): string => (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, n)
  for (const e of entries ?? []) {
    if (e.kind === 'message') {
      const m = e.message as { role: string; content: Array<Record<string, unknown>> }
      if (m.role !== 'assistant') continue
      for (const b of m.content) {
        if (b.type === 'text' && String(b.text).trim()) out.push(`model: ${short(b.text)}`)
        if (b.type === 'toolUse') out.push(`tool: ${String(b.name)} ${short(b.input, 200)}`)
      }
    } else if (e.kind === 'tools') out.push(`tools: ${short((e.calls as unknown[]) ?? [], 300)}`)
    else if (e.kind === 'guard' && e.verdict !== 'ok') out.push(`guard: ${short(e.problems)} ${e.words ? short(e.words) : ''}`.trim())
    else if (e.kind === 'judge') {
      const row = judges[j++]
      const read = row ? short((typeof row.input === 'string' ? JSON.parse(row.input) : row.input)?.message ?? '', 400) : ''
      out.push(`judge: ${String(e.verdict)}${e.category ? ` ${String(e.category)}` : ''}${e.reason ? `: ${short(e.reason, 160)}` : ''}${e.error ? ` (${String(e.error)})` : ''}${e.verdict !== 'pass' ? ` | read: ${read}` : ''}`)
    } else if (e.kind === 'error' || e.kind === 'handoff') out.push(`${String(e.kind)}: ${short(e.error ?? e.reason)}`)
  }
  return out
}

function emptyRun(p: Persona, catalog: 'seeded' | 'unseeded'): ConversationRun {
  return { personaId: p.id, category: p.category, catalog, messages: [], turns: [], handoffs: [], optedOutAfterSeq: null, appointmentChanges: [], renderedPhrases: [], intake: [], error: null }
}

async function rateQuality(provider: AiProvider, prompt: string, prices: AiPrices): Promise<{ verdict: QualityVerdict | null; error: string | null; costMicros: number }> {
  let cost = 0
  let raw = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await provider.converse({ system: [{ text: QUALITY_RUBRIC }], messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 700, temperature: 0 })
      cost += usageCost(res.usage, prices)
      raw = textOf(res.message)
      return { verdict: parseQualityVerdict(raw), error: null, costMicros: cost }
    } catch (e) {
      if (attempt === 1) return { verdict: null, error: `${(e as Error).message.slice(0, 200)} :: ${raw.slice(0, 300)}`, costMicros: cost }
    }
  }
  return { verdict: null, error: 'unreachable', costMicros: cost }
}

/** The runtime's environment: everything on, the eval's models, the shop's numbers; global caps raised for the eval's volume. */
export function evalEnvBase(extra: Record<string, string> = {}): Record<string, string> {
  const pass = (k: string): Record<string, string> => (process.env[k] ? { [k]: process.env[k]! } : {})
  return {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL_TEST ?? '',
    EMAIL_CONSOLE_DIR: mkdtempSync(path.join(tmpdir(), 'oasis-eval-mail-')),
    SMSGATE_MIN_INTERVAL_MS: '0',
    AI_ENABLED: 'true',
    AI_ACTIONS_ENABLED: 'true',
    PUBLIC_LINKS_ENABLED: 'true',
    PIN_PEPPER: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_SITE_URL: 'https://oasisautospanj.com',
    BUSINESS_PHONE,
    BUSINESS_TEXT_NUMBER,
    // the eval runs many conversations in one simulated hour on one shop: the shop-wide caps and the daily budget would hand off
    // after 100 turns; the per-number caps stay as in production
    AI_GLOBAL_TURNS_HOUR: '100000',
    AI_GLOBAL_TURNS_DAY: '1000000',
    AI_DAILY_BUDGET_USD: '10000',
    AI_SMS_SEGMENTS_PER_30MIN: '1000',
    ...pass('AI_PROVIDER'),
    ...pass('AI_BEDROCK_MODEL_ID'),
    ...pass('AI_BEDROCK_REGION'),
    ...pass('AI_GUARD_MODEL_ID'),
    ...extra,
  }
}

export interface EvalRunResult {
  results: PersonaResult[]
  skipped: string[]
  lines: string[]
}

/** Runs the selected personas; returns the results and the printed report. */
export async function evalConversations(argv: readonly string[], deps: EvalDeps = {}): Promise<EvalRunResult> {
  const o = parseArgs(argv)
  const log = deps.log ?? ((l: string) => console.log(l))
  const url = databaseUrl()
  const fixture = parsePersonas(JSON.parse(readFileSync(o.personas, 'utf8')))
  const envBase = evalEnvBase(deps.env)
  const env0 = loadEnv(envBase)
  const modelPrices = (id: string): AiPrices => findClaudeModel(id)?.prices ?? highestListPrices()
  // provider errors are printed (the turn stores only their kind)
  const gate = new RpmGate(o.rpm, CALLS_PER_TURN)
  const logged = (p: AiProvider, role: string): AiProvider => ({
    name: p.name,
    model: p.model,
    converse: async (req, opts) => {
      if (role !== 'quality') gate.record()
      const t0 = performance.now()
      try {
        const r = await p.converse(req, opts)
        if (process.env.EVAL_DEBUG)
          log(
            `call ${role}: ${Math.round(performance.now() - t0)} ms, stop ${r.rawStopReason}, in ${r.usage.inputTokens} out ${r.usage.outputTokens} cache r${r.usage.cacheReadTokens}/w${r.usage.cacheWriteTokens}${role === 'judge' && (r.stopReason !== 'end_turn' || parseVerdict(textOf(r.message)) === null) ? ` UNPARSED: ${textOf(r.message).slice(0, 600)}` : ''}`,
          )
        return r
      } catch (e) {
        log(`provider error (${role}) after ${Math.round(performance.now() - t0)} ms: ${(e as Error).name} ${(e as { kind?: string }).kind ?? ''} ${(e as Error).message.slice(0, 300)}`)
        throw e
      }
    },
  })
  const providers: EvalProviders = deps.providers ?? {
    assistant: logged(createAiProvider(env0), 'assistant'),
    judge: logged(createAiProvider({ ...env0, AI_BEDROCK_MODEL_ID: env0.AI_GUARD_MODEL_ID ?? env0.AI_BEDROCK_MODEL_ID }), 'judge'),
    quality: o.quality ? logged(createAiProvider({ ...env0, AI_BEDROCK_MODEL_ID: QUALITY_MODEL, AI_TIMEOUT_MS: 60_000 }), 'quality') : null,
    simulator: logged(createAiProvider(env0), 'simulator'),
  }
  if (!o.quality) providers.quality = null
  const qualityPrices = modelPrices(QUALITY_MODEL)
  const simPrices = modelPrices(env0.AI_BEDROCK_MODEL_ID)

  const selected = fixture.personas.filter((p) => (o.only ? o.only.includes(p.id) : true) && (o.categories ? o.categories.includes(p.category) : true))
  const jobs: Array<{ persona: Persona; index: number; catalog: 'seeded' | 'unseeded' }> = []
  for (const [index, persona] of fixture.personas.entries()) {
    if (!selected.includes(persona)) continue
    if (o.catalog !== 'unseeded') jobs.push({ persona, index, catalog: 'seeded' })
    if (o.catalog !== 'seeded' && (persona.unseeded || o.only !== null)) jobs.push({ persona, index, catalog: 'unseeded' })
  }
  if (jobs.length === 0) throw new Error('no persona selected')
  log(`eval-conversations: ${jobs.length} conversations, provider ${env0.AI_PROVIDER} (${env0.AI_BEDROCK_MODEL_ID}), quality ${providers.quality ? QUALITY_MODEL : 'off'}, budget $${o.budgetUsd}, ${o.rpm} calls a minute, cwd ${process.cwd()}`)

  const prefix = deps.schemaPrefix ?? `eval_convo_${createHash('sha1').update(process.cwd()).digest('hex').slice(0, 8)}`
  const workers = Math.min(o.concurrency, jobs.length)
  const worlds = Array.from({ length: workers }, (_, i) => new EvalWorld(`${prefix}_${i}`, url))
  for (const w of worlds) await w.open()
  const tally: Tally = { usd: 0 }
  const results: PersonaResult[] = []
  const skipped: string[] = []
  let next = 0
  const work = async (w: EvalWorld): Promise<void> => {
    for (;;) {
      const job = jobs[next++]
      if (!job) return
      const tag = `${job.persona.id}/${job.catalog}`
      if (tally.usd >= o.budgetUsd) {
        skipped.push(tag)
        log(`skip ${tag}: the budget of $${o.budgetUsd} is spent ($${tally.usd.toFixed(3)})`)
        continue
      }
      const began = performance.now()
      const r = await runPersona(w, job.persona, { index: job.index, catalog: job.catalog, startAt: fixture.startAt, envBase, providers, tally, simPrices, gate })
      const costMicros = r.run.turns.reduce((n, t) => n + t.costMicros, 0)
      tally.usd += costMicros / 1e6
      let evalCost = r.evalCostMicros
      let quality: QualityVerdict | null = null
      let qualityError: string | null = null
      if (providers.quality && !job.persona.expect.noAiReply) {
        const q = await rateQuality(providers.quality, qualityPrompt({ factsText: r.factsText, persona: job.persona, run: r.run }), qualityPrices)
        tally.usd += q.costMicros / 1e6
        evalCost += q.costMicros
        quality = q.verdict
        qualityError = q.error
      }
      const check = checkConversation(r.run, job.persona)
      const result: PersonaResult = {
        personaId: job.persona.id,
        category: job.persona.category,
        catalog: job.catalog,
        check,
        quality,
        qualityError,
        turns: r.run.turns.length,
        fallbacks: r.run.turns.filter((t) => t.fallback).length,
        fallbackOk: job.persona.expect.fallbackOk,
        handoffs: r.run.handoffs,
        latencyMs: r.run.turns.map((t) => t.latencyMs),
        costMicros,
        evalCostMicros: evalCost,
        run: r.run,
      }
      results.push(result)
      log(
        `done ${tag} in ${((performance.now() - began) / 1000).toFixed(0)} s: turns ${result.turns}, breaches ${check.breaches.length}${check.breaches.length ? ` ${JSON.stringify(check.breaches)}` : ''}, misses ${check.misses.length}${check.misses.length ? ` ${JSON.stringify(check.misses)}` : ''}, Q ${quality?.overall ?? qualityError ?? '-'}, cost $${(costMicros / 1e6).toFixed(4)}, spent $${tally.usd.toFixed(3)} (checkout ${process.cwd()})`,
      )
    }
  }
  try {
    await Promise.all(worlds.map((w) => work(w)))
  } finally {
    for (const w of worlds) await w.close(true)
  }
  const order = new Map(jobs.map((j, i) => [`${j.persona.id}/${j.catalog}`, i]))
  results.sort((a, b) => (order.get(`${a.personaId}/${a.catalog}`) ?? 0) - (order.get(`${b.personaId}/${b.catalog}`) ?? 0))
  const lines = formatReport(results)
  if (skipped.length) lines.push(`skipped (budget): ${skipped.join(', ')}`)
  if (o.json) writeFileSync(o.json, `${JSON.stringify({ results, skipped }, null, 1)}\n`)
  if (o.transcripts) {
    const md = results.map((r) => {
      const q = r.quality ? `Q ${r.quality.overall} (h${r.quality.helpfulness} t${r.quality.tone} c${r.quality.correctness} f${r.quality.flow}): ${r.quality.reason}` : `Q -: ${r.qualityError ?? 'not rated'}`
      return [`## ${r.personaId} (${r.catalog}, ${r.category})`, '', q, '', `breaches: ${JSON.stringify(r.check.breaches)}; misses: ${JSON.stringify(r.check.misses)}; notes: ${JSON.stringify(r.check.notes)}`, `turns: ${r.run.turns.map((t) => `${t.status}${t.error ? `(${t.error})` : ''} ${(t.latencyMs / 1000).toFixed(1)}s ${t.judge.join('/')}`).join('; ')}`, `intake: ${r.run.intake.join(' > ')}`, ...r.run.turns.flatMap((t, i) => (t.judge.some((x) => x !== 'pass') || t.error ? [`turn ${i + 1} trace:`, ...t.trace.map((l) => `  ${l}`)] : [])), '', '```', renderTranscript(r.run, { redactCodes: true }), '```', ''].join('\n')
    })
    writeFileSync(o.transcripts, md.join('\n'))
  }
  return { results, skipped, lines }
}

if (process.argv[1] && process.argv[1].endsWith('eval-conversations.ts')) {
  evalConversations(process.argv.slice(2)).then(
    ({ lines }) => {
      console.log(lines.join('\n'))
      process.exit(0)
    },
    (e: unknown) => {
      console.error((e as Error).stack ?? (e as Error).message)
      process.exit(2)
    },
  )
}
