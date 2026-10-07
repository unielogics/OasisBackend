// The simulator object store is mounted on the app: the photo flow's presigned POST and the signed thumbnail URLs work
// over HTTP (they 404ed before it was mounted), from the dashboard origin, and never in production.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStorageProvider } from '../../src/integrations/storage/config.js'
import { FsStorage } from '../../src/integrations/storage/fs-provider.js'
import { shouldMountDevStorage } from '../../src/http/routes/dev-storage.js'
import { useTestDb } from '../helpers/db.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { HEIC, JPEG, multipartBody } from '../integrations/storage/helpers/multipart.js'

const t = useTestDb()
let ctx: TestApp | undefined
let root = ''
afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  if (root) rmSync(root, { recursive: true, force: true })
})

const KEY = 'loc/l1/appt/a1/before/p1.jpg'
const DASHBOARD = 'http://localhost:3000'

async function start(env: Record<string, string> = {}): Promise<TestApp> {
  root = mkdtempSync(path.join(tmpdir(), 'oasis-devstore-'))
  ctx = await createTestApp({
    testDb: t,
    modules: [],
    env: {
      STORAGE_PROVIDER: 'fs',
      STORAGE_FS_ROOT: root,
      PUBLIC_API_URL: 'http://localhost:4000',
      PUBLIC_DASHBOARD_URL: DASHBOARD,
      ...env,
    },
  })
  return ctx
}

describe('/dev-storage', () => {
  it('takes a presigned POST, serves the signed download and answers CORS for the dashboard origin', async () => {
    const { app, env, clock } = await start()
    const storage = createStorageProvider(env, { clock }) as FsStorage
    const slot = await storage.createUpload({
      key: KEY,
      contentType: 'image/jpeg',
      maxBytes: 4096,
      ttlSec: 300,
    })
    expect(slot.url).toBe('http://localhost:4000/dev-storage/upload')

    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/dev-storage/upload',
      headers: { origin: DASHBOARD, 'access-control-request-method': 'POST' },
    })
    expect(pre.statusCode).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe(DASHBOARD)

    const form = multipartBody(slot.fields, { data: JPEG, contentType: 'image/jpeg' })
    const up = await app.inject({
      method: 'POST',
      url: '/dev-storage/upload',
      headers: { 'content-type': form.contentType, origin: DASHBOARD },
      payload: form.body,
    })
    expect(up.statusCode).toBe(204)
    expect(up.headers['access-control-allow-origin']).toBe(DASHBOARD)
    expect((await storage.get(KEY)).equals(JPEG)).toBe(true)

    const url = new URL(await storage.getDownloadUrl(KEY, 600))
    const down = await app.inject({ method: 'GET', url: url.pathname + url.search })
    expect(down.statusCode).toBe(200)
    expect(down.headers['content-type']).toBe('image/jpeg')
    // an <img> on the dashboard origin must be allowed to show it
    expect(down.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(Buffer.from(down.rawPayload).equals(JPEG)).toBe(true)
  })

  it('refuses a HEIC file with the message the dashboard shows, and a tampered signature', async () => {
    const { app, env, clock } = await start()
    const storage = createStorageProvider(env, { clock }) as FsStorage
    const slot = await storage.createUpload({
      key: KEY,
      contentType: 'image/jpeg',
      maxBytes: 4096,
      ttlSec: 300,
    })
    const heic = multipartBody(slot.fields, { data: HEIC, contentType: 'image/jpeg' })
    const r = await app.inject({
      method: 'POST',
      url: '/dev-storage/upload',
      headers: { 'content-type': heic.contentType, origin: DASHBOARD },
      payload: heic.body,
    })
    expect(r.statusCode).toBe(415)
    expect(r.json()).toMatchObject({ error: { code: 'HEIC_NOT_SUPPORTED' } })
    const bad = multipartBody({ ...slot.fields, key: 'loc/l1/appt/a1/before/other.jpg' }, { data: JPEG })
    const r2 = await app.inject({
      method: 'POST',
      url: '/dev-storage/upload',
      headers: { 'content-type': bad.contentType, origin: DASHBOARD },
      payload: bad.body,
    })
    expect(r2.statusCode).toBe(403)
  })

  it('is mounted only for the filesystem store outside production', () => {
    const env = (e: Record<string, string>) => e as never
    expect(shouldMountDevStorage(env({ STORAGE_PROVIDER: 'fs', NODE_ENV: 'development' }))).toBe(true)
    expect(shouldMountDevStorage(env({ STORAGE_PROVIDER: 'fs', NODE_ENV: 'test' }))).toBe(true)
    expect(shouldMountDevStorage(env({ STORAGE_PROVIDER: 'fs', NODE_ENV: 'production' }))).toBe(false)
    expect(shouldMountDevStorage(env({ STORAGE_PROVIDER: 's3', NODE_ENV: 'development' }))).toBe(false)
  })

  it('answers 404 on the real app when the store is S3', async () => {
    const { app } = await start({ STORAGE_PROVIDER: 's3', S3_BUCKET: 'bucket' })
    const r = await app.inject({ method: 'GET', url: '/dev-storage/files/x?exp=1&sig=2' })
    expect(r.statusCode).toBe(404)
  })
})
