// The tailnet-facing listener. The SMS Gate webhook is served ONLY here (HOOKS_HOST:HOOKS_PORT, default 127.0.0.1:3002,
// reached through `tailscale serve --set-path /hooks/smsgate`); the public listener has no such route and answers 404.
import Fastify, { type FastifyInstance } from 'fastify'
import { installRawBodyParsers, WEBHOOK_BODY_LIMIT } from '../../../http/webhooks.js'
import type { AppInstance } from '../../../http/types.js'
import type { MessagingRuntime } from '../runtime.js'

const SWEEP_EVERY_MS = 30_000

export interface HooksApp {
  app: FastifyInstance
  /** Starts listening; resolves with the bound address. */
  listen(): Promise<string>
  close(): Promise<void>
}

export async function buildHooksApp(rt: MessagingRuntime, o: { host: string; port: number; logger?: import('fastify').FastifyBaseLogger }): Promise<HooksApp> {
  const app = Fastify({ ...(o.logger ? { loggerInstance: o.logger } : { logger: false }), bodyLimit: WEBHOOK_BODY_LIMIT, trustProxy: false })
  installRawBodyParsers(app as unknown as AppInstance)

  app.post<{ Params: { deviceKey: string } }>('/hooks/smsgate/:deviceKey', async (req, reply) => {
    const res = await rt.webhooks.receive(req.params.deviceKey, req.headers, req.rawBody ?? '')
    return reply.code(res.status).send(res.body)
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, status: 'not_found' }))
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    req.log.error({ err: err.message }, 'hooks listener error')
    // 5xx makes the device retry the delivery, which is what we want for anything we did not persist
    return reply.code(err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500).send({ ok: false, status: 'error' })
  })
  await app.ready()

  let sweep: NodeJS.Timeout | undefined
  return {
    app,
    async listen() {
      const address = await app.listen({ host: o.host, port: o.port })
      const run = (): void => {
        void rt.webhooks.sweep().catch((err: unknown) => rt.log.error({ err: (err as Error).message }, 'webhook sweep failed'))
      }
      run()
      sweep = setInterval(run, SWEEP_EVERY_MS)
      sweep.unref()
      return address
    },
    async close() {
      if (sweep) clearInterval(sweep)
      await app.close()
      await rt.idle()
    },
  }
}
