import type { Readable } from 'node:stream'
import { DEV_STORAGE_PREFIX, type FsStorage } from './fs-provider.js'
import { parseMultipart } from './multipart.js'
import { sniffImageType } from './sniff.js'
import { HEIC_MESSAGE, MAX_UPLOAD_BYTES, StorageError, type StorageErrorCode } from './types.js'

export interface DevStorageRequest {
  method: string
  /** Request target: path plus query. Absolute URLs are accepted. */
  url: string
  headers: Record<string, string | string[] | undefined>
  /** Raw body (needed for POST). The HTTP layer must buffer multipart/form-data and cap it at MAX_BODY_BYTES. */
  body?: Buffer
}

export interface DevStorageResponse {
  status: number
  headers: Record<string, string>
  body?: Buffer | Readable | string
}

/** Largest request body the handler will look at: the 15 MB file plus form fields and boundaries. */
export const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 256 * 1024

const STATUS: Partial<Record<StorageErrorCode, number>> = {
  BAD_SIGNATURE: 403,
  EXPIRED: 403,
  TOO_LARGE: 413,
  TOO_SMALL: 400,
  HEIC_NOT_SUPPORTED: 415,
  UNSUPPORTED_TYPE: 415,
  CONTENT_MISMATCH: 415,
  NOT_FOUND: 404,
  INVALID_KEY: 400,
  INVALID_ARGUMENT: 400,
}

export interface FsHandlerOptions {
  /** Dashboard origin allowed to POST/GET cross-origin (the S3 CORS rule's twin). */
  allowOrigin?: string
}

const header = (h: DevStorageRequest['headers'], name: string): string => {
  const v = h[name] ?? h[name.toLowerCase()]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

/**
 * Framework-agnostic handler for the simulator's storage endpoints, mounted under DEV_STORAGE_PREFIX:
 *   POST {prefix}/upload                multipart form from UploadSlot (fields first, then `file`)
 *   GET|HEAD {prefix}/files/{key}?exp&sig   signed download
 *   OPTIONS                             CORS preflight
 * Fastify: addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES }, (_, b, d) => d(null, b)),
 * then route `${DEV_STORAGE_PREFIX}/*` to this function and send the returned status, headers and body verbatim.
 * Only mount when ALLOW_DEV_ENDPOINTS or STORAGE_PROVIDER=fs.
 */
export function createFsStorageHandler(
  storage: FsStorage,
  opts: FsHandlerOptions = {},
): (req: DevStorageRequest) => Promise<DevStorageResponse> {
  const cors: Record<string, string> = opts.allowOrigin
    ? { 'Access-Control-Allow-Origin': opts.allowOrigin, Vary: 'Origin' }
    : {}

  const json = (status: number, code: string, message: string): DevStorageResponse => ({
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
    body: JSON.stringify({ error: { code, message } }),
  })

  return async (req) => {
    try {
      const url = new URL(req.url, 'http://dev.invalid')
      if (!url.pathname.startsWith(`${DEV_STORAGE_PREFIX}/`)) return json(404, 'NOT_FOUND', 'unknown path')
      const rest = url.pathname.slice(DEV_STORAGE_PREFIX.length)
      const method = req.method.toUpperCase()

      if (method === 'OPTIONS') {
        return {
          status: 204,
          headers: {
            ...cors,
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '600',
          },
        }
      }

      if (method === 'POST' && rest === '/upload') {
        const body = req.body
        if (!body) throw new StorageError('INVALID_ARGUMENT', 'empty request body')
        if (body.length > MAX_BODY_BYTES) throw new StorageError('TOO_LARGE', 'request body is too large')
        const form = parseMultipart(body, header(req.headers, 'content-type'))
        const { key, contentType, maxBytes } = storage.verifyUploadFields(form.fields)
        if (!form.file) throw new StorageError('INVALID_ARGUMENT', 'form has no file part')
        const data = form.file.data
        if (data.length < 1) throw new StorageError('TOO_SMALL', 'file is empty')
        if (data.length > maxBytes)
          throw new StorageError(
            'TOO_LARGE',
            `file is larger than the ${maxBytes} byte limit for this upload`,
          )
        const sniffed = sniffImageType(data)
        if (sniffed === 'image/heic') throw new StorageError('HEIC_NOT_SUPPORTED', HEIC_MESSAGE)
        if (sniffed !== contentType) {
          throw new StorageError(
            'CONTENT_MISMATCH',
            `file content does not match the declared type ${contentType}`,
          )
        }
        await storage.put(key, data, contentType)
        return { status: 204, headers: { 'Cache-Control': 'no-store', ...cors } }
      }

      if ((method === 'GET' || method === 'HEAD') && rest.startsWith('/files/')) {
        const key = rest
          .slice('/files/'.length)
          .split('/')
          .map((s) => decodeURIComponent(s))
          .join('/')
        storage.verifyDownload(key, url.searchParams.get('exp'), url.searchParams.get('sig'))
        const meta = await storage.head(key)
        if (!meta) throw new StorageError('NOT_FOUND', 'object does not exist')
        const headers = {
          'Content-Type': meta.contentType,
          'Content-Length': String(meta.bytes),
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=0, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          ...cors,
        }
        return method === 'HEAD'
          ? { status: 200, headers }
          : { status: 200, headers, body: await storage.openRead(key) }
      }

      return json(404, 'NOT_FOUND', 'unknown path')
    } catch (e) {
      if (e instanceof StorageError) return json(STATUS[e.code] ?? 500, e.code, e.message)
      if (e instanceof URIError) return json(400, 'INVALID_KEY', 'malformed URL')
      throw e
    }
  }
}
