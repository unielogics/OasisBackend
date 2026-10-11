// The assistant's wiring (ADR 0160, the W3 contract): one AssistantDeps per process (what every W3 part receives), the turn's deps
// (the AI provider, the tool registry, the shop facts, the gate, the conversation store), the job operations `respond` (debounce,
// then the turn) and `sweep` (re-kick old markers, fail dead leases), and the messaging runtime's ports (useAssistant: the kick,
// the welcome flow, the reply-number handler once W3b's real one is in).
import type { Env } from '../../config/env.js'
import { createAiProvider } from '../../integrations/ai/index.js'
import type { AiProvider } from '../../integrations/ports/ai.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db } from '../../platform/db.js'
import { NIL_UUID, type NewId } from '../../platform/ids.js'
import type { EnqueueOptions } from '../../platform/jobs.js'
import { schedulingPortsFor } from '../../composition.js'
import { createAssistantGate } from '../messaging/assistant/gate.js'
import { createPgAssistantInbox } from '../messaging/assistant/inbox.js'
import type { MessagingRuntime } from '../messaging/runtime.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import { ownerOf } from '../identity/common.js'
import { createActionCodeHandler } from './actions/handler.js'
import { assistantConfig, type AssistantConfig } from './config.js'
import { AI_ACTOR_NAME, type AssistantDeps, type AssistantLog, type ShopFactsSource, type ToolRegistry } from './contract.js'
import { buildShopFacts } from './facts.js'
import { HANDOFF_SUMMARIES, openTurnHandoff, sendFallback } from './handoff.js'
import { noActionCodes, type AssistantGate, type AssistantKick, type AssistantPorts } from './ports.js'
import { createToolRegistry } from './tools/index.js'
import { runTurn, type TurnDeps, type TurnResult } from './turn.js'
import { createNewTexters } from './welcome/new-texters.js'
import './schema.js'

export const AI_RESPOND_JOB = 'ai.respond'
export const AI_SWEEP_JOB = 'ai.sweep'

/** Enqueues a job (the pg-boss handle of the process: the API's producer or the worker's). */
export type Enqueue = (name: string, data: object, opts?: EnqueueOptions) => Promise<string | null>

const quiet: AssistantLog = { info: () => undefined, warn: () => undefined, error: () => undefined }

/** The assistant's actor: permissions sched.edit + jobs.status only, audit name "Oasis AI (SMS)" (design section 4). */
export function assistantActor(locationId: string): Actor {
  return {
    auth: { userId: NIL_UUID, employeeId: null, locationId, permissions: new Set(['sched.edit', 'jobs.status']), actorName: AI_ACTOR_NAME },
    audit: { actor: { userId: null, name: AI_ACTOR_NAME } },
  }
}

/** The kick of the webhook path: one debounced ai.respond per conversation (stately, singletonKey = the conversation). */
export function jobsKick(enqueue: Enqueue, debounceMs: number): AssistantKick {
  const startAfter = debounceMs > 0 ? Math.max(1, Math.ceil(debounceMs / 1000)) : undefined
  return {
    async kick(ids) {
      for (const id of new Set(ids)) await enqueue(AI_RESPOND_JOB, { conversationId: id }, { singletonKey: id, ...(startAfter ? { startAfter } : {}) })
    },
  }
}

export interface AssistantRuntimeOptions {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  messaging: MessagingRuntime
  /** The pg-boss enqueue of this process (re-kicks and deferrals); without it they are left to ai.sweep. */
  enqueue?: Enqueue
  provider?: AiProvider
  /** The output guard's judge (default: createAiProvider for AI_GUARD_MODEL_ID; the simulator passes every reply). */
  judgeProvider?: AiProvider
  registry?: ToolRegistry
  facts?: ShopFactsSource
  gate?: AssistantGate
  log?: AssistantLog
  cfg?: Partial<AssistantConfig>
}

export interface RespondOutcome {
  status: 'off' | 'none' | 'deferred' | TurnResult['status']
  turn?: TurnResult
}

export class AssistantRuntime {
  readonly cfg: AssistantConfig
  readonly deps: AssistantDeps
  readonly turnDeps: TurnDeps
  private registryCache: ToolRegistry | undefined

  constructor(readonly o: AssistantRuntimeOptions) {
    const { db, clock, newId, env, messaging } = o
    this.cfg = { ...assistantConfig(env), ...o.cfg }
    const log = o.log ?? quiet
    const facts = o.facts ?? buildShopFacts({ db, clock, env })
    const schedulingFor = (locationId: string): SchedulingCtx => ({
      clock,
      newId,
      locationId,
      tz: env.BUSINESS_TZ,
      ports: schedulingPortsFor({ db, clock, env, newId }, messaging),
    })
    this.deps = { db, clock, newId, env, queue: messaging.queue, log, facts, schedulingFor, actorFor: assistantActor }
    const registry = (): ToolRegistry => this.registry()
    this.turnDeps = {
      db,
      clock,
      newId,
      env,
      cfg: this.cfg,
      provider: o.provider ?? createAiProvider(env),
      judge: o.judgeProvider ?? createAiProvider({ ...env, AI_BEDROCK_MODEL_ID: this.cfg.judge.modelId }),
      get registry() {
        return registry()
      },
      facts,
      queue: messaging.queue,
      inbox: createPgAssistantInbox({ newId }),
      gate: o.gate ?? createAssistantGate({ aiEnabled: this.cfg.aiEnabled, ownNumbers: ownNumbersOf(env) }),
      log,
      schedulingFor,
      actorFor: assistantActor,
      kick: (ids) => (o.enqueue ? jobsKick(o.enqueue, 0).kick(ids) : Promise.resolve()),
    }
  }

  /** W3b's tool registry (the contract stub offers none), built once. */
  registry(): ToolRegistry {
    return (this.registryCache ??= this.o.registry ?? createToolRegistry(this.deps))
  }

  /** The ports the messaging runtime calls on the inbound path (useAssistant). */
  ports(): Partial<AssistantPorts> {
    const parts: Partial<AssistantPorts> = {
      // the W2d gate, with the texting line among the shop's own numbers too
      gate: this.o.gate ?? createAssistantGate({ aiEnabled: this.cfg.aiEnabled, ownNumbers: ownNumbersOf(this.o.env) }),
      newTexters: createNewTexters(this.deps),
      ...(this.o.enqueue ? { kick: jobsKick(this.o.enqueue, this.cfg.debounceMs) } : {}),
    }
    // the contract stub is the W2d "nothing pending" default; until W3b's real handler exists the messaging runtime's own default
    // (which still looks pending actions up, so a reply number is never filed readable) stays in place
    const codes = createActionCodeHandler(this.deps)
    if (codes !== noActionCodes) parts.actionCodes = codes
    return parts
  }

  /**
   * ai.respond: answers the conversation's waiting texts once the newest is AI_DEBOUNCE_MS old (a burst gets one answer), or at the
   * latest 45 seconds after the first of them; before that the job defers itself.
   */
  async respond(conversationId: string): Promise<RespondOutcome> {
    if (!this.cfg.aiEnabled) return { status: 'off' }
    const c = await this.o.db
      .selectFrom('assistant_conversations')
      .select(['pending_since', 'last_inbound_at'])
      .where('id', '=', conversationId)
      .executeTakeFirst()
    if (!c?.pending_since) return { status: 'none' }
    const now = this.o.clock.now().getTime()
    const quietFor = now - (c.last_inbound_at ?? c.pending_since).getTime()
    const age = now - c.pending_since.getTime()
    if (quietFor < this.cfg.debounceMs && age < this.cfg.maxDeferMs && this.o.enqueue) {
      const waitMs = Math.min(this.cfg.debounceMs - quietFor, this.cfg.maxDeferMs - age)
      await this.o.enqueue(AI_RESPOND_JOB, { conversationId }, { singletonKey: conversationId, startAfter: Math.max(1, Math.ceil(waitMs / 1000)) })
      return { status: 'deferred' }
    }
    const turn = await runTurn(this.turnDeps, conversationId)
    return { status: turn.status, turn }
  }

  /** ai.sweep: re-kicks markers older than 30 seconds that no turn holds; fails leases older than 3 minutes (fallback + handoff). */
  async sweep(): Promise<{ kicked: number; leasesFailed: number }> {
    if (!this.cfg.aiEnabled) return { kicked: 0, leasesFailed: 0 }
    const { db, clock } = this.o
    const now = clock.now()
    const dead = await db
      .selectFrom('assistant_conversations')
      .select('id')
      .where('running_since', '<', new Date(now.getTime() - this.cfg.leaseMs))
      .limit(100)
      .execute()
    let leasesFailed = 0
    for (const { id } of dead) if (await this.failLease(id)) leasesFailed += 1
    const waiting = await db
      .selectFrom('assistant_conversations')
      .select('id')
      .where('pending_since', '<', new Date(now.getTime() - this.cfg.sweepMarkerMs))
      .where('running_since', 'is', null)
      .where((eb) => eb.or([eb('handoff_state', 'is', null), eb('handoff_state', '!=', 'open')]))
      .orderBy('pending_since')
      .limit(100)
      .execute()
    if (waiting.length > 0 && this.o.enqueue) await jobsKick(this.o.enqueue, 0).kick(waiting.map((w) => w.id))
    return { kicked: this.o.enqueue ? waiting.length : 0, leasesFailed }
  }

  /** A turn that died holding its lease: its row fails, the client gets the fallback, staff get the conversation. */
  async failLease(conversationId: string): Promise<boolean> {
    const { db, clock, newId } = this.o
    const now = clock.now()
    return transaction(db, async (tx) => {
      const c = await tx
        .selectFrom('assistant_conversations')
        .select(['id', 'location_id', 'phone_e164', 'customer_id', 'running_since'])
        .where('id', '=', conversationId)
        .where('running_since', '<', new Date(now.getTime() - this.cfg.leaseMs))
        .forUpdate()
        .executeTakeFirst()
      if (!c) return false
      const turns = await tx
        .updateTable('assistant_turns')
        .set({ status: 'failed', error: 'lease_timeout', finished_at: now })
        .where('conversation_id', '=', c.id)
        .where('status', '=', 'running')
        .returning('id')
        .execute()
      const ref = { id: c.id, locationId: c.location_id, phone: c.phone_e164, threadCustomerId: c.customer_id ?? (await ownerOf(tx, c.phone_e164)) ?? null }
      const hd = { clock, newId, queue: this.deps.queue, inbox: this.turnDeps.inbox }
      await sendFallback(tx, hd, ref, { turnId: turns[0]?.id ?? `lease:${c.id}:${now.getTime()}`, everyMs: this.cfg.fallbackEveryMs })
      await openTurnHandoff(tx, hd, ref, { reason: 'lease_timeout', summary: HANDOFF_SUMMARIES.lease_timeout! })
      await tx.updateTable('assistant_conversations').set({ running_since: null, pending_since: null, updated_at: now }).where('id', '=', c.id).execute()
      return true
    })
  }
}

/** The shop's own numbers the gate never answers: the calling number and the texting line. */
export function ownNumbersOf(env: Pick<Env, 'BUSINESS_PHONE' | 'BUSINESS_TEXT_NUMBER'>): string[] {
  return [env.BUSINESS_PHONE, env.BUSINESS_TEXT_NUMBER].filter((x): x is string => typeof x === 'string' && x.trim() !== '')
}

/**
 * Plugs the assistant into a process's messaging runtime: the kick (pg-boss ai.respond), the welcome flow and, once W3b's real one
 * exists, the reply-number handler. With AI_ENABLED=false or assistant.enabled=false the gate admits nothing, so none of them is ever
 * called and every text is routed as before.
 */
export function wireAssistant(o: AssistantRuntimeOptions): AssistantRuntime {
  const runtime = new AssistantRuntime(o)
  o.messaging.useAssistant(runtime.ports())
  return runtime
}
