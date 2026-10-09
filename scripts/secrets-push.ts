// pnpm secrets:push --secret-id ID [--from FILE] [--keys A,B] [--remove KEY ...] [--profile NAME] [--region R] [--apply]
//
// Writes settings into the Secrets Manager secret the app reads its environment from (OASIS_SECRET_ID, src/config/secrets-source.ts).
// Plan first: it prints the identity, then one line per KEY (+ new, ~ changes, = unchanged, - removed, kept) and never a value;
// --apply writes. Keys in FILE are added or replaced, keys not in FILE stay as they are, --remove deletes one (repeatable).
//   --from FILE     a dotenv file (NAME=value per line, # comments, optional quotes), e.g. the output of deploy/scripts/gen-secrets.sh
//   --keys A,B      only these keys of FILE (e.g. moving DATABASE_URL,SESSION_SECRET,SECRETS_KEY out of /etc/oasis/common.env)
// Every key must be declared by the environment contract (src/config/env.ts); OASIS_SECRET_ID, AWS_REGION and AWS credentials are
// refused (they must be known before the secret can be read). A missing secret is created with the AWS-managed KMS key
// (aws/secretsmanager) and the tag app=oasis. Restart oasis-api and oasis-worker afterwards: they read the secret at start.
//
// Credentials: --profile NAME (the operator profile) or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in the environment, never both.
// AWS_EC2_METADATA_DISABLED=true is set before any client exists, so this operator tool never acts as the instance role.
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { envSchema } from '../src/config/env.js'
import { FORBIDDEN_SECRET_KEYS, secretKeyProblems } from '../src/config/secrets-source.js'

export const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .split('\nimport ')[0]!
  .replace(/^\/\/ ?/gm, '')

export interface PushClients {
  sm: Pick<SecretsManagerClient, 'send'>
  sts: Pick<STSClient, 'send'>
}

export interface PushDeps {
  env: Record<string, string | undefined>
  log: (line: string) => void
  clients?: (cfg: { region: string; profile?: string }) => PushClients
}

class UsageError extends Error {}

const defaultClients = (cfg: { region: string; profile?: string }): PushClients => {
  const base = { region: cfg.region, ...(cfg.profile ? { profile: cfg.profile } : {}) }
  return { sm: new SecretsManagerClient(base), sts: new STSClient(base) }
}

const KEY = /^[A-Z][A-Z0-9_]*$/

/** NAME=value lines the way the deploy kit writes them (systemd EnvironmentFile rules); errors name the line number, never content. */
export function parseDotenv(text: string, label: string): Map<string, string> {
  const out = new Map<string, string>()
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) throw new UsageError(`${label} line ${i + 1} is not NAME=value`)
    let v = m[2]!
    if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) v = v.slice(1, -1)
    if (out.has(m[1]!)) throw new UsageError(`${label} sets ${m[1]} twice (line ${i + 1})`)
    out.set(m[1]!, v)
  })
  return out
}

/** Field checks of the environment contract for the keys being written; messages name the key, never the value. */
export function invalidValues(values: Map<string, string>): string[] {
  const shape = envSchema.innerType().shape as Record<string, { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ code: string; message: string; options?: unknown[] }> } } }>
  const out: string[] = []
  for (const [k, v] of values) {
    if (v === '') {
      out.push(`${k}: empty (use --remove ${k} to delete a key)`)
      continue
    }
    const field = shape[k]
    if (!field) continue
    const r = field.safeParse(v)
    if (!r.success) {
      const issue = r.error!.issues[0]!
      // an enum issue quotes what it received; name the allowed values instead
      out.push(`${k}: ${issue.code === 'invalid_enum_value' ? `must be one of ${(issue.options ?? []).join(', ')}` : issue.message}`)
    }
  }
  const sk = values.get('SECRETS_KEY')
  if (sk && Buffer.from(sk, 'base64').length !== 32) out.push('SECRETS_KEY: must be base64 of 32 random bytes (gen-secrets.sh SECRETS_KEY)')
  return out.sort()
}

const errName = (e: unknown): string => (e as { name?: string }).name ?? 'Error'

export async function main(argv: string[], deps: PushDeps): Promise<number> {
  const { log } = deps
  let a
  try {
    a = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : argv,
      allowPositionals: false,
      options: {
        help: { type: 'boolean' },
        apply: { type: 'boolean' },
        'secret-id': { type: 'string' },
        from: { type: 'string' },
        keys: { type: 'string' },
        remove: { type: 'string', multiple: true },
        profile: { type: 'string' },
        region: { type: 'string' },
      },
    }).values
  } catch (e) {
    log(`secrets:push: ${(e as Error).message}\n\n${HELP}`)
    return 2
  }
  if (a.help) {
    log(HELP)
    return 0
  }
  // an operator tool: never the instance role, whatever else happens
  process.env.AWS_EC2_METADATA_DISABLED = 'true'
  const envKeys = !!deps.env.AWS_ACCESS_KEY_ID && !!deps.env.AWS_SECRET_ACCESS_KEY
  try {
    if (!a.profile && !envKeys)
      throw new UsageError('refusing to run without credentials chosen on purpose: pass --profile <name> (the operator profile) or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY')
    if (a.profile && envKeys) throw new UsageError('both --profile and AWS_ACCESS_KEY_ID are set; unset one so it is clear which identity acts')
    const secretId = a['secret-id']?.trim()
    if (!secretId || !/^[A-Za-z0-9/_+=.@:-]{1,2048}$/.test(secretId)) throw new UsageError('--secret-id is required (a secret name such as oasis/prod/app, or its ARN)')
    const region = a.region ?? 'us-east-1'
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new UsageError(`--region "${region}" is not an AWS region`)
    if (!a.from && !a.remove?.length) throw new UsageError('nothing to push: give --from FILE and/or --remove KEY')
    if (a.keys && !a.from) throw new UsageError('--keys selects keys of --from FILE')

    const incoming = new Map<string, string>()
    if (a.from) {
      const st = statSync(a.from, { throwIfNoEntry: false })
      if (!st?.isFile()) throw new UsageError(`--from ${a.from} is not a readable file`)
      const all = parseDotenv(readFileSync(a.from, 'utf8'), path.basename(a.from))
      const wanted = a.keys ? a.keys.split(',').map((k) => k.trim()).filter(Boolean) : [...all.keys()]
      const bad = wanted.filter((k) => !KEY.test(k))
      if (bad.length) throw new UsageError(`--keys: not variable names: ${bad.join(', ')}`)
      const absent = wanted.filter((k) => !all.has(k))
      if (absent.length) throw new UsageError(`--keys: ${path.basename(a.from)} does not set ${absent.join(', ')}`)
      for (const k of wanted) incoming.set(k, all.get(k)!)
      if ((st.mode & 0o077) !== 0)
        log(`warning: ${a.from} is readable by other users (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it, and shred it once pushed`)
    }
    const { forbidden, unknown } = secretKeyProblems(incoming.keys())
    if (forbidden.length)
      throw new UsageError(`these keys must not live in the secret: ${forbidden.map((k) => `${k} (${FORBIDDEN_SECRET_KEYS[k]})`).join(', ')}; keep them in /etc/oasis/common.env`)
    if (unknown.length)
      throw new UsageError(`these keys are not declared by the environment contract (src/config/env.ts): ${unknown.join(', ')}; pass --keys to choose the ones to push`)
    const invalid = invalidValues(incoming)
    if (invalid.length) throw new UsageError(`refusing invalid values:\n  ${invalid.join('\n  ')}`)
    const removes = [...new Set(a.remove ?? [])]
    const badRemove = removes.filter((k) => !KEY.test(k))
    if (badRemove.length) throw new UsageError(`--remove: not variable names: ${badRemove.join(', ')}`)
    const both = removes.filter((k) => incoming.has(k))
    if (both.length) throw new UsageError(`${both.join(', ')}: both set from --from and removed; choose one`)

    const c = (deps.clients ?? defaultClients)({ region, ...(a.profile ? { profile: a.profile } : {}) })
    const who = await c.sts.send(new GetCallerIdentityCommand({}))
    log(`identity: ${who.Arn ?? '(unknown)'} (account ${who.Account ?? '?'})`)

    let exists = true
    let current: Record<string, string> = {}
    try {
      const d = await c.sm.send(new DescribeSecretCommand({ SecretId: secretId }))
      if (d.DeletedDate) throw new UsageError(`secret ${secretId} is scheduled for deletion; restore it first (aws secretsmanager restore-secret --secret-id ${secretId})`)
      log(`secret: ${d.ARN ?? secretId} (KMS key ${d.KmsKeyId ?? 'aws/secretsmanager'})`)
    } catch (e) {
      if (errName(e) !== 'ResourceNotFoundException') throw e
      exists = false
      log(`secret: ${secretId} does not exist in ${region}`)
    }
    if (exists) {
      try {
        const v = await c.sm.send(new GetSecretValueCommand({ SecretId: secretId }))
        let doc: unknown
        try {
          doc = JSON.parse(v.SecretString ?? '')
        } catch {
          doc = undefined
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.values(doc).some((x) => typeof x !== 'string'))
          throw new UsageError(`the current value of ${secretId} is not a JSON object of strings; it would be lost: fix or empty it by hand first`)
        current = doc as Record<string, string>
      } catch (e) {
        // a secret created without a value has no AWSCURRENT version yet
        if (errName(e) !== 'ResourceNotFoundException') throw e
      }
    }

    const next: Record<string, string> = { ...current }
    const lines: string[] = []
    let changes = 0
    for (const [k, v] of [...incoming].sort(([x], [y]) => x.localeCompare(y))) {
      const before = current[k]
      const mark = before === undefined ? '+' : before === v ? '=' : '~'
      if (mark !== '=') changes++
      lines.push(`  ${mark} ${k}${mark === '+' ? ' (new)' : mark === '~' ? ' (changes)' : ' (unchanged)'}`)
      next[k] = v
    }
    for (const k of removes.sort()) {
      if (k in current) {
        changes++
        lines.push(`  - ${k} (removed)`)
        delete next[k]
      } else lines.push(`    ${k} (not in the secret; nothing to remove)`)
    }
    for (const k of Object.keys(current).sort()) if (!incoming.has(k) && !removes.includes(k)) lines.push(`    ${k} (kept)`)
    const leftovers = secretKeyProblems(Object.keys(next))
    if (leftovers.forbidden.length || leftovers.unknown.length)
      log(`warning: the app will refuse this secret until these keys are removed (--remove): ${[...leftovers.forbidden, ...leftovers.unknown].join(', ')}`)

    log('')
    log(`Plan for ${secretId} (+ new, ~ changes, = unchanged, - removed; values are never shown):`)
    if (!exists) log(`  + create the secret (KMS key aws/secretsmanager, tag app=oasis)`)
    for (const l of lines) log(l)
    log('')
    if (changes === 0 && exists) {
      log('Nothing to change.')
      return 0
    }
    if (!a.apply) {
      log(`${changes} change(s). Nothing was written. Run again with --apply.`)
      return 0
    }
    const SecretString = JSON.stringify(Object.fromEntries(Object.entries(next).sort(([x], [y]) => x.localeCompare(y))))
    if (exists) await c.sm.send(new PutSecretValueCommand({ SecretId: secretId, SecretString }))
    else
      await c.sm.send(
        new CreateSecretCommand({
          Name: secretId,
          Description: 'Oasis Auto Spa application environment (pnpm secrets:push)',
          SecretString,
          Tags: [{ Key: 'app', Value: 'oasis' }],
        }),
      )
    log(`applied: ${changes} change(s) to ${secretId}. Restart the services to use them: sudo systemctl restart oasis-api oasis-worker`)
    return 0
  } catch (e) {
    if (e instanceof UsageError) {
      log(`secrets:push: ${e.message}`)
      return 2
    }
    const x = e as { name?: string; message?: string }
    log(`secrets:push: AWS refused: ${x.name ?? 'Error'}: ${x.message ?? String(e)}`)
    return 1
  }
}

if (process.argv[1]?.endsWith('secrets-push.ts')) {
  main(process.argv.slice(2), { env: process.env, log: (l) => console.log(l) }).then((code) => process.exit(code))
}
