import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox as createMessagingBox } from '../../src/modules/messaging/crypto.js'
import { DeviceStore } from '../../src/modules/messaging/db/devices.js'
import { ConnectionStore } from '../../src/modules/payments-sync/db/connection.js'
import { createSecretBox as createKeyedBox } from '../../src/modules/payments-sync/db/secrets.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import {
  RotationError,
  SECRET_COLUMNS,
  classify,
  formatOf,
  generateKey,
  keyIdOf,
  main,
  rotateSecrets,
  updateEnvFile,
} from '../../scripts/secrets-rotate.js'
import { useTestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const t = useTestDb()
const OLD = generateKey()
const NEW = generateKey()
const old = { kind: 'key', base64: OLD } as const
const next = { kind: 'key', base64: NEW } as const
const scratch = mkdtempSync(path.join(tmpdir(), 'oasis-rotate-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

interface Seeded {
  locationId: string
  deviceId: string
  deviceKey: string
}

/** Writes credentials the way production does: the real device store and connection store under the OLD key. */
async function seed(): Promise<Seeded> {
  const newId = createIdGenerator(t.clock)
  const location = await ensureLocation(t.db, newId, { timezone: 'America/New_York' })
  const devices = new DeviceStore(t.db, createMessagingBox(OLD, 'production'), { clock: t.clock, newId })
  const created = await devices.create(location.id, {
    label: 'Front desk tablet',
    provider: 'smsgate',
    baseUrl: 'http://100.64.0.7:8080',
    username: 'tablet-user',
    password: 'tablet-pass-123',
    webhookSecret: 'signing-key-abcdef',
  })
  const keyed = createKeyedBox([OLD])
  const conn = new ConnectionStore(t.db, {
    locationId: location.id,
    clock: t.clock,
    newId,
    secrets: () => keyed,
  })
  await conn.save('sqsp-api-key-live-123', { verified: true })
  await sql`insert into sqsp_webhook_subscriptions (id, location_id, sqsp_subscription_id, topic, endpoint_url, secret_enc)
    values (${newId()}::uuid, ${location.id}::uuid, 'sub-1', 'order.create', 'https://example.test/hooks/squarespace', ${keyed.encrypt('00ff00ff')})`.execute(
    t.db,
  )
  return { locationId: location.id, deviceId: created.device.id, deviceKey: created.device.device_key }
}

const run = (o: { apply: boolean; oldKey?: typeof old; newKey?: typeof next }) =>
  rotateSecrets({
    url: testDatabaseUrl(),
    schema: t.schema,
    oldKey: o.oldKey ?? old,
    newKey: o.newKey ?? next,
    apply: o.apply,
  })

const snapshot = async (): Promise<string> => {
  const parts: string[] = []
  for (const { table, column } of SECRET_COLUMNS) {
    const r = await sql<{
      v: string
    }>`select ${sql.id(column)} as v from ${sql.id(table)} where ${sql.id(column)} is not null order by id`.execute(
      t.db,
    )
    parts.push(...r.rows.map((x) => x.v))
  }
  return parts.join('\n')
}

describe('format detection', () => {
  it('recognises both stored formats and nothing else', () => {
    expect(formatOf(createMessagingBox(OLD, 'production').encrypt('x'))).toBe('messaging')
    expect(formatOf(createKeyedBox([OLD]).encrypt('x'))).toBe('keyed')
    expect(formatOf('plaintext-secret')).toBeNull()
    expect(formatOf('v1.only.two')).toBeNull()
  })

  it('classifies a value by the key it is under', () => {
    const sealed = createKeyedBox([OLD]).encrypt('x')
    expect(classify(sealed, old, next)).toBe('rotate')
    expect(classify(createKeyedBox([NEW]).encrypt('x'), old, next)).toBe('already_rotated')
    expect(classify(createKeyedBox([generateKey()]).encrypt('x'), old, next)).toBe('undecryptable')
    expect(classify('garbage', old, next)).toBe('unrecognised')
  })

  it('key ids are stable, short and differ per key', () => {
    expect(keyIdOf(old)).toBe(keyIdOf({ kind: 'key', base64: OLD }))
    expect(keyIdOf(old)).not.toBe(keyIdOf(next))
    expect(keyIdOf(old)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('rotateSecrets', () => {
  beforeEach(async () => {
    await sql`truncate sms_devices, sqsp_connections, sqsp_webhook_subscriptions cascade`.execute(t.db)
  })

  it('a dry run decrypts everything with the old key and writes nothing', async () => {
    await seed()
    const before = await snapshot()
    const r = await run({ apply: false })
    expect(r.applied).toBe(false)
    expect(r.rotated).toBe(4) // device password + webhook secret, API key, subscription secret
    expect(r.alreadyRotated).toBe(0)
    expect(r.columns.find((c) => c.column === 'password_enc')).toMatchObject({ total: 1, rotated: 1 })
    expect(await snapshot()).toBe(before)
  })

  it('apply moves every value to the new key: the production readers work with the new key and fail with the old one', async () => {
    const s = await seed()
    const r = await run({ apply: true })
    expect(r.applied).toBe(true)
    expect(r.rotated).toBe(4)

    const newDevices = new DeviceStore(t.db, createMessagingBox(NEW, 'production'), {
      clock: t.clock,
      newId: createIdGenerator(t.clock),
    })
    const row = (await newDevices.get(s.deviceId))!
    expect(newDevices.secrets(row)).toEqual({
      password: 'tablet-pass-123',
      webhookSecret: 'signing-key-abcdef',
    })
    const oldDevices = new DeviceStore(t.db, createMessagingBox(OLD, 'production'), {
      clock: t.clock,
      newId: createIdGenerator(t.clock),
    })
    expect(() => oldDevices.secrets(row)).toThrow()

    const conn = new ConnectionStore(t.db, {
      locationId: s.locationId,
      clock: t.clock,
      newId: createIdGenerator(t.clock),
      secrets: () => createKeyedBox([NEW]),
    })
    expect(await conn.apiKey()).toBe('sqsp-api-key-live-123')
    const sub = await sql<{ secret_enc: string }>`select secret_enc from sqsp_webhook_subscriptions`.execute(
      t.db,
    )
    expect(createKeyedBox([NEW]).decrypt(sub.rows[0]!.secret_enc)).toBe('00ff00ff')
    expect(createKeyedBox([NEW]).keyId).toBe(sub.rows[0]!.secret_enc.split(':')[0])
  })

  it('is idempotent: a second apply finds everything already on the new key and changes no byte', async () => {
    await seed()
    await run({ apply: true })
    const afterFirst = await snapshot()
    const again = await run({ apply: true })
    expect(again.rotated).toBe(0)
    expect(again.alreadyRotated).toBe(4)
    expect(await snapshot()).toBe(afterFirst)
  })

  it('resumes a half-rotated database (some values on the new key already)', async () => {
    const s = await seed()
    const keyedNew = createKeyedBox([NEW])
    await sql`update sqsp_connections set api_key_enc = ${keyedNew.encrypt('sqsp-api-key-live-123')}`.execute(
      t.db,
    )
    const r = await run({ apply: true })
    expect(r.rotated).toBe(3)
    expect(r.alreadyRotated).toBe(1)
    const conn = new ConnectionStore(t.db, {
      locationId: s.locationId,
      clock: t.clock,
      newId: createIdGenerator(t.clock),
      secrets: () => keyedNew,
    })
    expect(await conn.apiKey()).toBe('sqsp-api-key-live-123')
  })

  it('refuses everything and writes nothing when one value fits neither key', async () => {
    await seed()
    await sql`update sms_devices set password_enc = ${createMessagingBox(generateKey(), 'production').encrypt('x')}`.execute(
      t.db,
    )
    const before = await snapshot()
    await expect(run({ apply: true })).rejects.toThrow(/cannot be decrypted with either key/)
    expect(await snapshot()).toBe(before)
  })

  it('refuses a value that is not in an encrypted format and names the row, never the value', async () => {
    await seed()
    await sql`update sqsp_connections set api_key_enc = 'sk-this-is-plaintext'`.execute(t.db)
    const err = await run({ apply: true }).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(RotationError)
    expect((err as Error).message).toMatch(/sqsp_connections\.api_key_enc row/)
    expect((err as Error).message).not.toContain('sk-this-is-plaintext')
  })

  it('refuses identical keys and a malformed key', async () => {
    await expect(run({ apply: true, newKey: old })).rejects.toThrow(/same/)
    await expect(
      main(
        ['--url', testDatabaseUrl(), '--schema', t.schema],
        { SECRETS_KEY: 'short', NEW_SECRETS_KEY: NEW },
        () => {},
      ),
    ).rejects.toThrow(/32 bytes/)
  })

  it('an empty database rotates nothing and succeeds', async () => {
    const r = await run({ apply: true })
    expect(r.rotated).toBe(0)
    expect(r.columns.every((c) => c.total === 0)).toBe(true)
  })

  it('rolls back every value when a write fails midway', async () => {
    await seed()
    // A CHECK that rejects the new sealed value of the second column makes the whole transaction fail after the first update.
    await sql
      .raw(
        `alter table sqsp_webhook_subscriptions add constraint rotate_probe check (secret_enc is null or secret_enc not like '${keyIdOf(next)}:%')`,
      )
      .execute(t.db)
    const before = await snapshot()
    try {
      await expect(run({ apply: true })).rejects.toThrow()
      expect(await snapshot()).toBe(before)
    } finally {
      await sql`alter table sqsp_webhook_subscriptions drop constraint rotate_probe`.execute(t.db)
    }
  })
})

describe('command line', () => {
  beforeEach(async () => {
    await sql`truncate sms_devices, sqsp_connections, sqsp_webhook_subscriptions cascade`.execute(t.db)
  })

  it('defaults to a dry run, prints no key, and --apply rewrites the env file with a backup and the same mode', async () => {
    await seed()
    const envFile = path.join(scratch, 'common.env')
    writeFileSync(envFile, `DATABASE_URL=postgres://x\nSECRETS_KEY=${OLD}\nOTHER=1\n`, { mode: 0o640 })
    const lines: string[] = []
    const env = { SECRETS_KEY: OLD, NEW_SECRETS_KEY: NEW }
    const base = ['--url', testDatabaseUrl(), '--schema', t.schema, '--env-file', envFile]

    await main(base, env, (l) => lines.push(l))
    expect(lines[0]).toMatch(/^DRY RUN/)
    expect(readFileSync(envFile, 'utf8')).toContain(OLD)

    lines.length = 0
    await main([...base, '--apply'], env, (l) => lines.push(l))
    const out = lines.join('\n')
    expect(out).toMatch(/^APPLIED/)
    expect(out).not.toContain(OLD)
    expect(out).not.toContain(NEW)
    const rewritten = readFileSync(envFile, 'utf8')
    expect(rewritten).toBe(`DATABASE_URL=postgres://x\nSECRETS_KEY=${NEW}\nOTHER=1\n`)
    expect(statSync(envFile).mode & 0o777).toBe(0o640)
    const backup = readFileSync(out.match(/kept as (\S+)/)![1]!, 'utf8')
    expect(backup).toContain(OLD)
  })

  it('--generate-new-key writes a 0600 key file and never prints the key', async () => {
    await seed()
    const keyFile = path.join(scratch, 'new.key')
    const lines: string[] = []
    await main(
      [
        '--url',
        testDatabaseUrl(),
        '--schema',
        t.schema,
        '--generate-new-key',
        '--new-key-out',
        keyFile,
        '--apply',
      ],
      { SECRETS_KEY: OLD },
      (l) => lines.push(l),
    )
    const generated = readFileSync(keyFile, 'utf8').trim()
    expect(Buffer.from(generated, 'base64')).toHaveLength(32)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(lines.join('\n')).not.toContain(generated)
    await expect(
      main(
        ['--url', testDatabaseUrl(), '--schema', t.schema, '--generate-new-key', '--new-key-out', keyFile],
        { SECRETS_KEY: OLD },
        () => {},
      ),
    ).rejects.toThrow(/already exists/)
  })

  it('names the missing key', async () => {
    await expect(main(['--url', testDatabaseUrl()], {}, () => {})).rejects.toThrow(/old key is missing/)
    await expect(main(['--url', testDatabaseUrl()], { SECRETS_KEY: OLD }, () => {})).rejects.toThrow(
      /new key is missing/,
    )
  })

  it('updateEnvFile appends the variable when the file does not have it', () => {
    const f = path.join(scratch, 'append.env')
    writeFileSync(f, 'A=1', { mode: 0o600 })
    updateEnvFile(f, 'SECRETS_KEY', 'k', '20261007000000')
    expect(readFileSync(f, 'utf8')).toBe('A=1\nSECRETS_KEY=k\n')
  })
})
