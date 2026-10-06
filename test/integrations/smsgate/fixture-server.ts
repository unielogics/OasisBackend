import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { httpFixtures } from './fixtures.js'

/**
 * Replays the recorded device exchanges in test/fixtures/smsgate/http.json over real HTTP. It keeps just enough state for a
 * session: which message ids it has accepted (a repeat POST gets the recorded 409) and which webhooks are registered.
 */
export class FixtureDeviceServer {
  private server?: Server
  private readonly fx = httpFixtures()
  readonly accepted = new Set<string>()
  readonly webhooks = new Map<string, unknown>()
  posts = 0
  /** When set, every device route answers this status (503 by default) like an overloaded or failing app. */
  failing: number | null = null

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : undefined
        const out = this.route(req.method ?? 'GET', new URL(req.url ?? '/', 'http://x').pathname, body, req.headers.authorization)
        res.writeHead(out.status, out.body === undefined ? out.headers : { 'content-type': 'application/json', ...out.headers })
        res.end(out.body === undefined ? undefined : JSON.stringify(out.body))
      })
    })
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }

  private doc(template: { body?: unknown }, id: string): unknown {
    const d = JSON.parse(JSON.stringify(template.body)) as { id: string }
    d.id = id
    return d
  }

  private route(method: string, path: string, body: Record<string, unknown> | undefined, auth: string | undefined): { status: number; body?: unknown; headers?: Record<string, string> } {
    if (this.failing !== null && path !== '/health') return { status: this.failing, body: { message: 'Queue limits exceeded; ensure device is online' } }
    if (path === '/health') {
      if (this.failing !== null) return { status: 503, body: { status: 'fail' } }
      return this.fx['get-health-pass']!.response
    }
    if (!auth?.startsWith('Basic ')) return this.fx['post-message-unauthorized']!.response
    const seg = path.split('/').filter(Boolean)
    if (seg[0] === 'messages' && method === 'POST') {
      const id = String(body?.id ?? '')
      if (!id) return this.fx['post-message-conflicting-ttl']!.response
      if (this.accepted.has(id)) return this.fx['post-message-duplicate']!.response
      this.accepted.add(id)
      this.posts += 1
      const accepted = this.fx['post-message-accepted']!.response
      return { ...accepted, body: this.doc(accepted, id) }
    }
    if (seg[0] === 'messages' && method === 'GET' && seg[1]) {
      const id = decodeURIComponent(seg[1])
      if (!this.accepted.has(id)) return this.fx['get-message-unknown']!.response
      return { status: 200, body: this.doc(this.fx['get-message-after-accept']!.response, id) }
    }
    if (seg[0] === 'webhooks' && method === 'GET') return { status: 200, body: [...this.webhooks.values()] }
    if (seg[0] === 'webhooks' && method === 'POST') {
      const id = String(body?.id)
      this.webhooks.set(id, { ...body, deviceId: null })
      return { status: 201, body: { ...body, deviceId: null } }
    }
    if (seg[0] === 'webhooks' && method === 'DELETE' && seg[1]) {
      this.webhooks.delete(decodeURIComponent(seg[1]))
      return { status: 204 }
    }
    return { status: 404, body: { message: 'not found' } }
  }
}
