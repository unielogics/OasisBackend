// pnpm secrets:rotate -- [--apply] [--old-key-env NAME | --old-key-file F | --old-key-dev]
//                        [--new-key-env NAME | --new-key-file F | --generate-new-key --new-key-out F]
//                        [--env-file /etc/oasis/common.env] [--url postgres://...] [--schema name]
//
// Re-encrypts every credential stored at rest from the old SECRETS_KEY to a new one:
//   sms_devices.password_enc, sms_devices.webhook_secret_enc                 (messaging format  v1.<iv>.<tag>.<ct>)
//   sqsp_connections.{api_key,client_secret,access_token,refresh_token}_enc  (payments format  <keyId>:<iv>:<tag>:<ct>)
//   sqsp_webhook_subscriptions.secret_enc                                    (payments format)
// Default is a DRY RUN: every value is decrypted with the old key (or recognised as already under the new key) and nothing is
// written. --apply rewrites all values in ONE transaction and reads each one back with the new key before committing, so a
// failure leaves the database exactly as it was. Re-running after a success reports every value as already rotated.
// Keys are read from environment variables or files, never from the command line, and are never printed.
// Services that hold the old key cannot read new ciphertext: stop the API and worker, rotate, change SECRETS_KEY, start them
// (docs/runbook.md, "Rotate secrets"). With --env-file the SECRETS_KEY line of that file is replaced after the commit.
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { createDb } from '../src/platform/db.js'
import { createSecretBox as createMessagingBox } from '../src/modules/messaging/crypto.js'
import { createSecretBox as createKeyedBox } from '../src/modules/payments-sync/db/secrets.js'

export type SecretFormat = 'messaging' | 'keyed'

export interface SecretColumn {
  table: string
  column: string
}

export const SECRET_COLUMNS: readonly SecretColumn[] = [
  { table: 'sms_devices', column: 'password_enc' },
  { table: 'sms_devices', column: 'webhook_secret_enc' },
  { table: 'sqsp_connections', column: 'api_key_enc' },
  { table: 'sqsp_connections', column: 'client_secret_enc' },
  { table: 'sqsp_connections', column: 'access_token_enc' },
  { table: 'sqsp_connections', column: 'refresh_token_enc' },
  { table: 'sqsp_webhook_subscriptions', column: 'secret_enc' },
]

export type KeyMaterial = { kind: 'key'; base64: string } | { kind: 'dev' }

export class RotationError extends Error {}

export function parseKey(raw: string, label: string): string {
  const trimmed = raw.trim()
  if (Buffer.from(trimmed, 'base64').length !== 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed))
    throw new RotationError(`${label} must be 32 bytes, base64 encoded`)
  return trimmed
}

export function keyIdOf(key: KeyMaterial): string {
  if (key.kind === 'dev') return 'development-key'
  return createHash('sha256').update(Buffer.from(key.base64, 'base64')).digest('hex').slice(0, 8)
}

export function generateKey(): string {
  return randomBytes(32).toString('base64')
}

export function formatOf(stored: string): SecretFormat | null {
  if (/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(stored)) return 'messaging'
  if (/^[0-9a-f]{8}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/.test(stored)) return 'keyed'
  return null
}

interface Sealer {
  open(stored: string): string
  seal(plain: string): string
}

function sealerFor(format: SecretFormat, key: KeyMaterial): Sealer {
  if (format === 'messaging') {
    const box =
      key.kind === 'dev'
        ? createMessagingBox(undefined, 'development')
        : createMessagingBox(key.base64, 'production')
    return { open: (s) => box.decrypt(s), seal: (p) => box.encrypt(p) }
  }
  if (key.kind === 'dev') throw new RotationError('The development key only exists for the messaging format')
  const box = createKeyedBox([key.base64])
  return { open: (s) => box.decrypt(s), seal: (p) => box.encrypt(p) }
}

export type ValueState = 'rotate' | 'already_rotated' | 'undecryptable' | 'unrecognised'

/** Which key a stored value is under, without revealing anything about it. */
export function classify(stored: string, oldKey: KeyMaterial, newKey: KeyMaterial): ValueState {
  const format = formatOf(stored)
  if (!format) return 'unrecognised'
  const attempt = (key: KeyMaterial): boolean => {
    try {
      sealerFor(format, key).open(stored)
      return true
    } catch {
      return false
    }
  }
  if (attempt(oldKey)) return 'rotate'
  if (attempt(newKey)) return 'already_rotated'
  return 'undecryptable'
}

export interface ColumnReport {
  table: string
  column: string
  total: number
  rotated: number
  alreadyRotated: number
}

export interface RotationReport {
  applied: boolean
  oldKeyId: string
  newKeyId: string
  columns: ColumnReport[]
  rotated: number
  alreadyRotated: number
}

export interface RotateOptions {
  url: string
  schema?: string
  oldKey: KeyMaterial
  newKey: KeyMaterial
  apply: boolean
  columns?: readonly SecretColumn[]
}

/** Rotates (or, without apply, only verifies) every stored credential. Throws RotationError and changes nothing on any problem. */
export async function rotateSecrets(o: RotateOptions): Promise<RotationReport> {
  if (keyIdOf(o.oldKey) === keyIdOf(o.newKey)) throw new RotationError('The old and the new key are the same')
  const db = createDb({
    url: o.url,
    poolMax: 1,
    applicationName: 'oasis-secrets-rotate',
    ...(o.schema ? { searchPath: `${o.schema},public` } : {}),
  })
  try {
    return await db.transaction().execute(async (tx) => {
      const columns: ColumnReport[] = []
      const problems: string[] = []
      const writes: Array<{
        table: string
        column: string
        id: string
        plain: string
        format: SecretFormat
      }> = []
      for (const { table, column } of o.columns ?? SECRET_COLUMNS) {
        const rows = await sql<{ id: string; value: string }>`
          select id::text as id, ${sql.id(column)} as value from ${sql.id(table)}
          where ${sql.id(column)} is not null order by id for update`.execute(tx)
        const report: ColumnReport = { table, column, total: rows.rows.length, rotated: 0, alreadyRotated: 0 }
        for (const row of rows.rows) {
          const state = classify(row.value, o.oldKey, o.newKey)
          if (state === 'already_rotated') report.alreadyRotated++
          else if (state === 'rotate') {
            const format = formatOf(row.value)!
            writes.push({
              table,
              column,
              id: row.id,
              plain: sealerFor(format, o.oldKey).open(row.value),
              format,
            })
            report.rotated++
          } else
            problems.push(
              `${table}.${column} row ${row.id}: ${
                state === 'unrecognised'
                  ? 'not in a known encrypted format'
                  : 'cannot be decrypted with either key'
              }`,
            )
        }
        columns.push(report)
      }
      if (problems.length)
        throw new RotationError(
          `Nothing was changed. ${problems.length} value(s) cannot be rotated:\n  ${problems.join('\n  ')}`,
        )

      if (o.apply) {
        for (const w of writes) {
          const sealed = sealerFor(w.format, o.newKey).seal(w.plain)
          await sql`update ${sql.id(w.table)} set ${sql.id(w.column)} = ${sealed} where id = ${w.id}::uuid`.execute(
            tx,
          )
        }
        for (const w of writes) {
          const back = await sql<{ value: string }>`
            select ${sql.id(w.column)} as value from ${sql.id(w.table)} where id = ${w.id}::uuid`.execute(tx)
          const stored = back.rows[0]?.value
          if (!stored || sealerFor(w.format, o.newKey).open(stored) !== w.plain)
            throw new RotationError(
              `Read-back check failed for ${w.table}.${w.column} row ${w.id}; rolled back`,
            )
        }
      }
      return {
        applied: o.apply,
        oldKeyId: keyIdOf(o.oldKey),
        newKeyId: keyIdOf(o.newKey),
        columns,
        rotated: writes.length,
        alreadyRotated: columns.reduce((n, c) => n + c.alreadyRotated, 0),
      }
    })
  } finally {
    await db.destroy()
  }
}

/** Replaces (or appends) NAME=value in an env file atomically, keeping the mode and leaving a timestamped backup. */
export function updateEnvFile(file: string, name: string, value: string, stamp: string): { backup: string } {
  const text = readFileSync(file, 'utf8')
  const line = `${name}=${value}`
  const re = new RegExp(`^${name}=.*$`, 'm')
  const next = re.test(text)
    ? text.replace(re, () => line)
    : `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${line}\n`
  const backup = `${file}.bak-${stamp}`
  copyFileSync(file, backup)
  const mode = statSync(file).mode & 0o777
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, next, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
  return { backup }
}

// ---- command line ------------------------------------------------------------------------------------------------------

function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>()
  const args = argv.filter((a) => a !== '--')
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) throw new RotationError(`Unexpected argument "${a}"`)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), true)
    else {
      out.set(a.slice(2), next)
      i++
    }
  }
  return out
}

function readKey(
  args: Map<string, string | true>,
  p: { prefix: 'old' | 'new'; defaultEnv: string; env: NodeJS.ProcessEnv },
): KeyMaterial | undefined {
  const file = args.get(`${p.prefix}-key-file`)
  if (typeof file === 'string')
    return { kind: 'key', base64: parseKey(readFileSync(file, 'utf8'), `${p.prefix} key file`) }
  const envName =
    typeof args.get(`${p.prefix}-key-env`) === 'string'
      ? (args.get(`${p.prefix}-key-env`) as string)
      : p.defaultEnv
  const raw = p.env[envName]
  if (raw) return { kind: 'key', base64: parseKey(raw, envName) }
  return undefined
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (l: string) => void = console.log,
): Promise<number> {
  const args = parseArgs(argv)
  if (args.has('help')) {
    log(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\nimport ')[0]!
        .replace(/^\/\/ ?/gm, ''),
    )
    return 0
  }
  const apply = args.has('apply') && !args.has('dry-run')
  const url = typeof args.get('url') === 'string' ? (args.get('url') as string) : env.DATABASE_URL
  if (!url) throw new RotationError('DATABASE_URL is not set (or pass --url)')

  const oldKey: KeyMaterial | undefined = args.has('old-key-dev')
    ? { kind: 'dev' }
    : readKey(args, { prefix: 'old', defaultEnv: 'SECRETS_KEY', env })
  if (!oldKey)
    throw new RotationError(
      'The old key is missing: set SECRETS_KEY, or use --old-key-env / --old-key-file / --old-key-dev',
    )

  let newKey = readKey(args, { prefix: 'new', defaultEnv: 'NEW_SECRETS_KEY', env })
  let generatedTo: string | undefined
  if (!newKey && args.has('generate-new-key')) {
    const out = args.get('new-key-out')
    if (typeof out !== 'string')
      throw new RotationError('--generate-new-key needs --new-key-out <file> (the key is never printed)')
    if (existsSync(out)) throw new RotationError(`${out} already exists; refusing to overwrite a key file`)
    const base64 = generateKey()
    writeFileSync(out, `${base64}\n`, { mode: 0o600 })
    newKey = { kind: 'key', base64 }
    generatedTo = out
  }
  if (!newKey)
    throw new RotationError(
      'The new key is missing: set NEW_SECRETS_KEY, or use --new-key-env / --new-key-file / --generate-new-key',
    )

  const schema = typeof args.get('schema') === 'string' ? (args.get('schema') as string) : undefined
  const report = await rotateSecrets({ url, ...(schema ? { schema } : {}), oldKey, newKey, apply })

  log(
    `${apply ? 'APPLIED' : 'DRY RUN (nothing written; add --apply to rotate)'}: old key ${report.oldKeyId} -> new key ${report.newKeyId}`,
  )
  if (generatedTo) log(`new key written to ${generatedTo} (mode 600)`)
  for (const c of report.columns)
    log(
      `  ${`${c.table}.${c.column}`.padEnd(46)} ${String(c.total).padStart(3)} stored, ${apply ? 're-encrypted' : 'to re-encrypt'} ${c.rotated}, already on the new key ${c.alreadyRotated}`,
    )
  log(
    `total: ${report.rotated} ${apply ? 're-encrypted' : 'to re-encrypt'}, ${report.alreadyRotated} already on the new key`,
  )

  if (apply) {
    const envFile = args.get('env-file')
    if (typeof envFile === 'string' && newKey.kind === 'key') {
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
      const { backup } = updateEnvFile(envFile, 'SECRETS_KEY', newKey.base64, stamp)
      log(
        `SECRETS_KEY in ${path.basename(envFile)} replaced (the previous file is kept as ${backup} and holds the old key: delete it once the services run)`,
      )
    } else {
      log(
        'Next: set SECRETS_KEY to the new key in the environment file and restart oasis-api and oasis-worker.',
      )
    }
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (existsSync('.env') && !process.env.DATABASE_URL) process.loadEnvFile('.env')
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof RotationError ? e.message : e)
      process.exit(e instanceof RotationError ? 2 : 1)
    },
  )
}
