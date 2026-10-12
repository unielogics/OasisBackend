// Process-wide wiring for the Square module (ADR 0171). Jobs receive only db, clock and logger, so the environment and the SquareApi
// come from here: the injected ones (tests, an embedding process) or the process environment parsed once and squareApiFor(env).
// The ingest handlers default to the core ones (wave Q2b: payments and refunds; the others still log until their waves).
import { loadEnv, type Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { squareApiFor, type SquareApiOptions } from '../../integrations/square/factory.js'
import type { Db, Tx } from '../../platform/db.js'
import type { EnqueueArgs, EnqueueOutcome } from '../messaging/queue.js'
import type { PaymentMessenger } from '../payments/messenger.js'
import { defaultPorts } from '../payments/ports.js'
import { squareCoreIngest } from './handlers.js'
import type { SquareIngest } from './ingest.js'

export interface SquareRuntimeOverrides {
  env?: Env
  /** Builds the API for an environment (tests point it at a simulator). */
  api?: (env: Env, o?: SquareApiOptions) => SquareApi
  /** The ingest handlers (default: the core handlers of wave Q2b). */
  ingest?: SquareIngest
  /** The messaging queue the card texts go through (tests; production: configureSquareQueue). */
  queue?: SquareQueue
}

/** The part of the messaging queue (DbMessageQueue) the card texts use: the card link, a fee charged. */
export interface SquareQueue {
  enqueueFor(tx: Tx, a: EnqueueArgs): Promise<EnqueueOutcome>
}

let overrides: SquareRuntimeOverrides = {}
let cachedEnv: Env | undefined
let messengerFor: ((db: Db) => PaymentMessenger) | undefined
let queueFor: (() => SquareQueue) | undefined

export function configureSquareRuntime(o: SquareRuntimeOverrides): void {
  overrides = o
}

/**
 * How the jobs text a payment link (the deposit link of a booking): the process's messaging queue, wired at boot (server and worker,
 * composition.ts configureProductionSquare). Unwired, the payments module's default messenger (the dev outbox outside production).
 */
export function configureSquareMessenger(fn: ((db: Db) => PaymentMessenger) | undefined): void {
  messengerFor = fn
}

export function squareMessenger(db: Db): PaymentMessenger {
  return messengerFor ? messengerFor(db) : defaultPorts().messenger
}

/**
 * How the jobs and the webhook text a card link or a charged fee (wave Q3a): the process's messaging queue, wired at boot (server and
 * worker, composition.ts configureProductionSquare). Unwired (and no test override), those texts are skipped and logged.
 */
export function configureSquareQueue(fn: (() => SquareQueue) | undefined): void {
  queueFor = fn
}

export function squareQueue(): SquareQueue | undefined {
  return overrides.queue ?? queueFor?.()
}

export function squareEnv(): Env {
  return overrides.env ?? (cachedEnv ??= loadEnv())
}

export function squareApi(env: Env = squareEnv(), o: SquareApiOptions = {}): SquareApi {
  return (overrides.api ?? squareApiFor)(env, o)
}

export function squareIngest(): SquareIngest {
  return overrides.ingest ?? squareCoreIngest
}
