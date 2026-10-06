import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SquarespaceSimApi } from './api.js'

/** Node http wrapper over SquarespaceSimApi. Listens on the loopback interface only. */
export function createSimHttpServer(api: SquarespaceSimApi): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://sim.local')
      const raw = await readBody(req)
      let body: unknown
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ type: 'INVALID_REQUEST_ERROR', message: 'body is not JSON' }))
          return
        }
      }
      const headers: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v
      const out = await api.handle({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers,
        body,
      })
      res
        .writeHead(out.status, { 'content-type': 'application/json', ...out.headers })
        .end(JSON.stringify(out.body))
    } catch (e) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ type: 'SERVER_ERROR', message: e instanceof Error ? e.message : String(e) }))
    }
  })
}

export async function listen(server: Server, port = 0, host = '127.0.0.1'): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const a = server.address() as AddressInfo
  return `http://${host}:${a.port}`
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
