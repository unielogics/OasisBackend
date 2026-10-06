import swagger from '@fastify/swagger'
import type { OpenAPIV3_1 } from 'openapi-types'
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod'
import { describeAccess, type RouteAccess } from './access.js'
import type { AppInstance } from './types.js'

export const API_VERSION = '1.0.0'

const problemSchema: OpenAPIV3_1.SchemaObject = {
  type: 'object',
  description:
    'RFC 9457 problem details. For guard failures title and detail are the exact strings the dashboard toasts.',
  required: ['type', 'title', 'status', 'code', 'detail'],
  properties: {
    type: { type: 'string', description: 'urn:oasis:problem:<code in kebab-case>' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: {
      type: 'string',
      description: 'Machine-readable code, e.g. SLOT_UNAVAILABLE, OVER_LIMIT, VERSION_CONFLICT',
    },
    detail: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'message'],
        properties: { path: { type: 'string' }, message: { type: 'string' } },
      },
    },
    requestId: { type: 'string' },
    meta: { type: 'object', additionalProperties: true },
  },
}

export async function registerOpenApi(app: AppInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Oasis Auto Spa API',
        version: API_VERSION,
        description:
          'Dashboard and back-office API. Errors are application/problem+json; money is integer cents; instants are ISO-8601 UTC; business dates are YYYY-MM-DD in the business timezone.',
      },
      servers: [{ url: '/' }],
      security: [{ cookieAuth: [] }],
      components: {
        securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: app.env.SESSION_COOKIE_NAME } },
        schemas: { Problem: problemSchema },
      },
    },
    transform: (arg) => {
      const out = jsonSchemaTransform(arg) as { schema?: Record<string, unknown>; url: string }
      out.schema ??= {}
      const cfg = (arg as { route?: { config?: { access?: RouteAccess; idempotency?: string } } }).route
        ?.config
      if (cfg?.access && !out.schema.hide) {
        out.schema['x-oasis-access'] = describeAccess(cfg.access)
        if (cfg.idempotency) out.schema['x-oasis-idempotency'] = cfg.idempotency
        if (cfg.access.kind === 'public' || cfg.access.kind === 'webhook') out.schema.security = []
      }
      return out as ReturnType<typeof jsonSchemaTransform>
    },
    transformObject: jsonSchemaTransformObject,
  })
}
