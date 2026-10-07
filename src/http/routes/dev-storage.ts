// The simulator's object store over HTTP: the S3 twin used when STORAGE_PROVIDER=fs (local development, the live-stack
// harness, the browser e2e). The presigned POST the photo flow hands the dashboard points here, and so do the signed
// thumbnail and download URLs. Authentication is the signature in the URL, exactly like S3, so the routes are public.
// Mounted outside /api/v1 (the URLs are `${PUBLIC_API_URL}/dev-storage/...`) and never in production.
import { createStorageProvider } from '../../integrations/storage/config.js'
import { createFsStorageHandler, MAX_BODY_BYTES } from '../../integrations/storage/fs-handler.js'
import { DEV_STORAGE_PREFIX, FsStorage } from '../../integrations/storage/fs-provider.js'
import { access } from '../access.js'
import type { AppInstance } from '../types.js'

export const shouldMountDevStorage = (env: AppInstance['env']): boolean =>
  env.STORAGE_PROVIDER === 'fs' && env.NODE_ENV !== 'production'

export async function registerDevStorageRoutes(app: AppInstance): Promise<void> {
  const storage = createStorageProvider(app.env, { clock: app.clock })
  if (!(storage instanceof FsStorage)) return
  const handle = createFsStorageHandler(storage, {
    allowOrigin: new URL(app.env.PUBLIC_DASHBOARD_URL).origin,
  })
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'multipart/form-data',
      { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES },
      (_req, body, done) => done(null, body),
    )
    scope.route({
      method: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      url: `${DEV_STORAGE_PREFIX}/*`,
      config: {
        access: access.public(
          'Simulator object store: every URL carries its own signature, like a presigned S3 URL',
        ),
        rateLimit: false,
      },
      schema: { hide: true },
      handler: async (req, reply) => {
        const r = await handle({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.isBuffer(req.body) ? req.body : undefined,
        })
        for (const [k, v] of Object.entries(r.headers)) void reply.header(k, v)
        // The photos are shown in <img> on the dashboard origin (S3 serves them without a resource policy).
        void reply.header('Cross-Origin-Resource-Policy', 'cross-origin')
        void reply.code(r.status)
        return r.body === undefined ? reply.send() : reply.send(r.body)
      },
    })
  })
}
