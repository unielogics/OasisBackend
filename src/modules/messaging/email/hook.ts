// POST /hooks/ses: Amazon SNS delivers SES bounce, complaint and delivery events here (ADR 0110). Public on purpose (AWS must reach
// it), so everything rests on the SNS signature: the certificate URL must be https on sns.<region>.amazonaws.com with a .pem path,
// SignatureVersion 1 (SHA1) or 2 (SHA256), the topic must be one of SES_SNS_TOPIC_ARNS, and the message at most an hour old (the
// longest SNS retries an HTTPS delivery). A message is processed once: its MessageId is claimed in webhook_log after the signature
// checks out. A SubscriptionConfirmation is followed only for an allow-listed topic and an SNS host.
import type { ApiModule } from '../../../http/modules.js'
import { webhookRoute } from '../../../http/webhooks.js'
import { sesTopicArns } from '../../../integrations/email/env.js'
import { SnsVerifier, type CertFetcher, type UrlFetcher } from '../../../integrations/email/sns.js'
import { createSesWebhookHandler } from '../../../integrations/email/webhook.js'
import type { Db } from '../../../platform/db.js'
import { createIdGenerator, type NewId } from '../../../platform/ids.js'
import type { Clock } from '../../../platform/clock.js'
import { recordFeedback } from './feedback.js'

/** SNS retries an HTTPS delivery for at most 3,600 seconds after publishing; a few minutes on top cover clock skew. */
export const SNS_MAX_AGE_SEC = 3600 + 300

export interface SesHookOptions {
  /** Certificate download (tests inject a local CA); default: fetch, 5 s timeout, no redirects, 64 KB cap. */
  fetchCertificate?: CertFetcher
  /** The GET of SubscribeURL that confirms a subscription. */
  confirm?: UrlFetcher
}

class SnsMessageDedupe {
  constructor(
    private readonly db: Db,
    private readonly newId: NewId,
    private readonly clock: Clock,
  ) {}

  async claim(messageId: string): Promise<boolean> {
    const r = await this.db
      .insertInto('webhook_log')
      .values({
        id: this.newId(),
        provider: 'ses',
        external_id: messageId,
        headers: '{}',
        body: null,
        signature_valid: true,
        received_at: this.clock.now(),
        status: 'received',
      })
      .onConflict((oc) => oc.columns(['provider', 'external_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    return r !== undefined
  }

  async release(messageId: string): Promise<void> {
    await this.db.deleteFrom('webhook_log').where('provider', '=', 'ses').where('external_id', '=', messageId).execute()
  }

  async finish(messageId: string, status: 'processed' | 'ignored', detail?: string): Promise<void> {
    await this.db
      .updateTable('webhook_log')
      .set({ status, processed_at: this.clock.now(), error: detail ? detail.slice(0, 300) : null })
      .where('provider', '=', 'ses')
      .where('external_id', '=', messageId)
      .execute()
  }
}

export function createSesHookModule(o: SesHookOptions = {}): ApiModule {
  return (app, deps) => {
    const topics = sesTopicArns(deps.env)
    const newId = deps.newId ?? createIdGenerator(deps.clock)
    const verifier = new SnsVerifier({
      clock: deps.clock,
      allowedTopicArns: topics,
      maxAgeSec: SNS_MAX_AGE_SEC,
      ...(o.fetchCertificate ? { fetchCertificate: o.fetchCertificate } : {}),
    })
    const handle = createSesWebhookHandler({
      verifier,
      dedupe: new SnsMessageDedupe(deps.db, newId, deps.clock),
      ...(o.confirm ? { confirm: o.confirm } : {}),
      onDecisions: async (decisions) => {
        const r = await recordFeedback(deps.db, decisions, { clock: deps.clock, newId })
        if (r.suppressed || r.softBounces)
          app.log.info(
            { suppressed: r.suppressed, newlySuppressed: r.newlySuppressed.length, softBounces: r.softBounces, delivered: r.delivered },
            'ses feedback recorded',
          )
      },
      log: (event, detail) => app.log.info(detail, event),
    })
    webhookRoute(app, {
      provider: 'ses',
      path: '/ses',
      handler: async (req, reply) => {
        // An empty allow-list would let the verifier accept any topic: refuse everything until SES_SNS_TOPIC_ARNS is set.
        if (topics.length === 0)
          return reply
            .status(403)
            .type('application/json')
            .send(JSON.stringify({ message: 'SES feedback is not accepted: SES_SNS_TOPIC_ARNS is not set' }))
        const r = await handle(req.rawBody ?? '')
        return reply.status(r.status).type('application/json').send(r.body)
      },
    })
  }
}

export const sesHookModule: ApiModule = createSesHookModule()
