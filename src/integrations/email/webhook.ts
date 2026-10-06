import { decideFromNotification, SesNotificationError, type FeedbackDecision } from './ses-events.js'
import {
  httpUrlFetcher,
  isSnsUrl,
  parseSnsEnvelope,
  SnsVerificationError,
  type SnsVerifier,
  type UrlFetcher,
} from './sns.js'

export interface WebhookResult {
  status: number
  body: string
}

export interface SesWebhookOptions {
  verifier: SnsVerifier
  /** Persist the decisions (suppression list, customers.email_bounced_at, outbox_emails state). Failures yield 500 so SNS retries. */
  onDecisions: (decisions: FeedbackDecision[]) => Promise<void> | void
  /** Fetches SubscribeURL to confirm a subscription. */
  confirm?: UrlFetcher
  log?: (event: string, detail: Record<string, unknown>) => void
}

const reply = (status: number, msg: string): WebhookResult => ({
  status,
  body: JSON.stringify({ message: msg }),
})

/**
 * Framework-agnostic handler for `POST /hooks/ses`. SNS posts JSON with content-type text/plain, so the HTTP layer
 * must hand over the raw body string. Mount it, return status/body verbatim:
 *   app.post('/hooks/ses', async (req, rep) => { const r = await handle(req.rawBody); rep.code(r.status).send(r.body) })
 */
export function createSesWebhookHandler(
  opts: SesWebhookOptions,
): (rawBody: string) => Promise<WebhookResult> {
  const confirm = opts.confirm ?? httpUrlFetcher
  const log = opts.log ?? (() => undefined)
  return async (rawBody) => {
    let env
    try {
      env = parseSnsEnvelope(rawBody)
      await opts.verifier.verify(env)
    } catch (err) {
      if (!(err instanceof SnsVerificationError)) throw err
      log('ses.webhook.rejected', { code: err.code })
      if (err.code === 'MALFORMED') return reply(400, 'malformed SNS message')
      // A certificate we could not fetch is transient: ask SNS to retry instead of dropping the notification.
      if (err.code === 'CERT_FETCH_FAILED') return reply(503, 'could not verify, retry')
      return reply(403, 'signature verification failed')
    }

    if (env.Type === 'SubscriptionConfirmation') {
      if (!env.SubscribeURL || !isSnsUrl(env.SubscribeURL))
        return reply(400, 'SubscribeURL is not an SNS URL')
      let res
      try {
        res = await confirm(env.SubscribeURL)
      } catch {
        return reply(502, 'could not confirm subscription, retry')
      }
      if (!res.ok) return reply(502, 'could not confirm subscription, retry')
      log('ses.webhook.subscription_confirmed', { topicArn: env.TopicArn })
      return reply(200, 'subscription confirmed')
    }
    if (env.Type === 'UnsubscribeConfirmation') {
      log('ses.webhook.unsubscribed', { topicArn: env.TopicArn })
      return reply(200, 'ignored')
    }

    let decisions: FeedbackDecision[]
    try {
      decisions = decideFromNotification(env.Message)
    } catch (err) {
      if (!(err instanceof SesNotificationError)) throw err
      log('ses.webhook.ignored', { reason: err.message })
      return reply(200, 'ignored: not an SES event')
    }
    try {
      await opts.onDecisions(decisions)
    } catch (err) {
      log('ses.webhook.persist_failed', { error: (err as Error).message })
      return reply(500, 'could not record feedback, retry')
    }
    return reply(200, `recorded ${decisions.length}`)
  }
}

/**
 * SQS delivery path (SES -> SNS -> SQS, polled by a job): the message body is either the SNS envelope
 * (default) or the bare SES JSON (raw message delivery). The queue's IAM policy is the trust boundary, so no
 * signature is checked here; pass a verifier to also authenticate wrapped envelopes.
 */
export async function decisionsFromQueueBody(
  body: string,
  opts: { verifier?: SnsVerifier } = {},
): Promise<FeedbackDecision[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new SesNotificationError('queue message is not valid JSON')
  }
  if (typeof parsed === 'object' && parsed !== null && 'Type' in parsed && 'Message' in parsed) {
    const env = parseSnsEnvelope(parsed)
    if (opts.verifier) await opts.verifier.verify(env)
    if (env.Type !== 'Notification') return []
    return decideFromNotification(env.Message)
  }
  return decideFromNotification(parsed as object)
}
