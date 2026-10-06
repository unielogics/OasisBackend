import type { SmsEvent } from '../../../integrations/ports/sms.js'
import type { Clock } from '../../../platform/clock.js'
import type { Dispatcher, EventResult } from './dispatcher.js'
import type { HealthEvaluation } from './health.js'
import type { ProcessedEventRepository } from './types.js'

type ReceivedEvent = Extract<SmsEvent, { kind: 'received' }>

export interface IngestExtras {
  health?: { status: 'pass' | 'warn' | 'fail'; battery?: number; charging?: boolean }
}

export type IngestResult =
  | { outcome: 'duplicate'; eventId: string }
  | { outcome: 'received'; eventId: string }
  | { outcome: 'handled'; eventId: string; result: EventResult; health?: HealthEvaluation }

/**
 * Entry point for verified webhook events. The device retries a delivery until it sees a 2xx (up to ~14 times over two
 * days), and a lost 2xx means the same envelope arrives again, so the envelope id is recorded first and a repeat is dropped.
 * Received messages are handed to `onReceived` (the inbound router service); everything else updates the outbox and health.
 */
export class SmsEventIngestor {
  constructor(
    private readonly processed: ProcessedEventRepository,
    private readonly dispatcher: Dispatcher,
    private readonly clock: Clock,
    private readonly onReceived: (event: ReceivedEvent) => Promise<void>,
  ) {}

  async ingest(event: SmsEvent, extras: IngestExtras = {}): Promise<IngestResult> {
    const fresh = await this.processed.markIfNew(event.eventId, this.clock.now())
    if (!fresh) return { outcome: 'duplicate', eventId: event.eventId }
    try {
      if (event.kind === 'received') {
        await this.onReceived(event)
        return { outcome: 'received', eventId: event.eventId }
      }
      const result = await this.dispatcher.handleEvent(event, extras)
      return { outcome: 'handled', eventId: event.eventId, result, health: result.health }
    } catch (err) {
      // Not processed: let the device's retry of this envelope through.
      await this.processed.forget(event.eventId)
      throw err
    }
  }
}
