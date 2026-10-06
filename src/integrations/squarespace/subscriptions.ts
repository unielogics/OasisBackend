/**
 * Webhook subscription management. The Webhook Subscriptions API (https://api.squarespace.com/1.0/webhook_subscriptions)
 * is OAuth only; API keys are not supported. The live HTTP implementation is intentionally not written yet:
 * it needs an OAuth app and a stored token (see AccessTokenProvider). Polling stays the baseline either way.
 */
export interface WebhookSubscription {
  id: string
  endpointUrl: string
  topics: string[]
  websiteId?: string
  createdOn?: string
  updatedOn?: string
}

export interface WebhookSubscriptionManager {
  list(): Promise<WebhookSubscription[]>
  /** The secret is only returned on create and on rotate: persist it immediately. */
  create(input: { endpointUrl: string; topics: string[] }): Promise<WebhookSubscription & { secret: string }>
  update(id: string, input: { endpointUrl?: string; topics?: string[] }): Promise<WebhookSubscription>
  delete(id: string): Promise<void>
  rotateSecret(id: string): Promise<{ secret: string }>
  sendTest(id: string, topic: string): Promise<void>
}

export interface EnsureResult {
  subscription: WebhookSubscription
  action: 'created' | 'updated' | 'unchanged'
  /** Present only when a secret was issued (create). Store it encrypted before doing anything else. */
  secret?: string
}

/** Idempotently make sure one subscription for `endpointUrl` carries exactly `topics`. */
export async function ensureWebhookSubscription(
  manager: WebhookSubscriptionManager,
  want: { endpointUrl: string; topics: readonly string[] },
): Promise<EnsureResult> {
  const topics = [...new Set(want.topics)].sort()
  const existing = (await manager.list()).find((s) => s.endpointUrl === want.endpointUrl)
  if (!existing) {
    const created = await manager.create({ endpointUrl: want.endpointUrl, topics })
    const { secret, ...subscription } = created
    return { subscription, action: 'created', secret }
  }
  const have = [...new Set(existing.topics)].sort()
  if (have.length === topics.length && have.every((t, i) => t === topics[i])) {
    return { subscription: existing, action: 'unchanged' }
  }
  return { subscription: await manager.update(existing.id, { topics }), action: 'updated' }
}

export class InMemoryWebhookSubscriptionManager implements WebhookSubscriptionManager {
  private subs = new Map<string, WebhookSubscription & { secret: string }>()
  private n = 0
  readonly tests: { id: string; topic: string }[] = []
  constructor(private readonly newSecret: () => string = () => 'ab'.repeat(32)) {}

  async list(): Promise<WebhookSubscription[]> {
    return [...this.subs.values()].map(strip)
  }
  async create(input: { endpointUrl: string; topics: string[] }) {
    if (!input.endpointUrl.startsWith('https://')) throw new Error('endpointUrl must be HTTPS')
    const sub = { id: `sub_${++this.n}`, ...input, secret: this.newSecret() }
    this.subs.set(sub.id, sub)
    return { ...strip(sub), secret: sub.secret }
  }
  async update(id: string, input: { endpointUrl?: string; topics?: string[] }) {
    const sub = this.require(id)
    Object.assign(sub, input)
    return strip(sub)
  }
  async delete(id: string): Promise<void> {
    this.require(id)
    this.subs.delete(id)
  }
  async rotateSecret(id: string) {
    const sub = this.require(id)
    sub.secret = this.newSecret()
    return { secret: sub.secret }
  }
  async sendTest(id: string, topic: string): Promise<void> {
    this.require(id)
    this.tests.push({ id, topic })
  }
  secretOf(id: string): string {
    return this.require(id).secret
  }
  private require(id: string) {
    const sub = this.subs.get(id)
    if (!sub) throw new Error(`no subscription ${id}`)
    return sub
  }
}

function strip(s: WebhookSubscription & { secret: string }): WebhookSubscription {
  return { id: s.id, endpointUrl: s.endpointUrl, topics: [...s.topics] }
}
