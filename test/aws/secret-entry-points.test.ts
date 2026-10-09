// Every program that reads the application environment goes through the Secrets Manager loader (src/config/secrets-source.ts), so
// production can keep its environment in the secret. The program list is DISCOVERED (package.json scripts, the compiled entry points
// the systemd units start, the TypeScript files the deploy scripts run, and every file with a "run as a program" guard), so a new
// entry point that calls loadEnv() or reads process.env without the loader fails here. Then real processes prove the wiring end to end
// against a local Secrets Manager endpoint.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sh, tempDir } from '../ops-kit/deploy-helpers.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { FakeSecretsHttp } from './helpers/fake-secrets-http.js'

const REPO = process.cwd()
const TSX = path.join(REPO, 'node_modules/.bin/tsx')

/** Programs that read an environment of their own on purpose, with the reason. Adding one here is a review decision. */
const EXEMPT: Record<string, string> = {
  'scripts/aws/provision.ts': 'operator tool: acts with the operator profile and must never pick up the runtime environment',
  'scripts/secrets-push.ts': 'operator tool: writes the secret with the operator profile',
  'scripts/openapi.ts': 'builds the document from a fixed test environment',
  'scripts/data-model.ts': 'reads only the migrations',
  'scripts/db-schema.ts': 'development: regenerates docs from a local database (DATABASE_URL from .env)',
  'scripts/sim-smsgate.ts': 'simulator: reads its own SIM_* settings',
  'scripts/sim-squarespace.ts': 'simulator',
  'scripts/verify-live/sim-aws.ts': 'simulator',
  'src/platform/jobs-doc.ts': 'writes docs/jobs.md from the job registry',
}

const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

function filesUnder(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name)
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : filesUnder(rel)
    return /\.(ts|mjs)$/.test(d.name) && !d.name.endsWith('.d.ts') ? [rel] : []
  })
}

/** Every file that runs as a program. */
export function discoverPrograms(): string[] {
  const found = new Set<string>()
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
  for (const cmd of Object.values(scripts))
    for (const m of cmd.matchAll(/\btsx(?: watch)? ((?:src|scripts|db|deploy)\/[\w/.-]+\.ts)\b/g)) found.add(m[1]!)
  for (const cmd of Object.values(scripts)) for (const m of cmd.matchAll(/\bnode dist\/([\w/-]+)\.js\b/g)) found.add(`src/${m[1]}.ts`)
  for (const unit of readdirSync(path.join(REPO, 'deploy/systemd')))
    for (const m of read(`deploy/systemd/${unit}`).matchAll(/\bnode dist\/([\w/-]+)\.js\b/g)) found.add(`src/${m[1]}.ts`)
  for (const sh of [...filesUnder('deploy/scripts'), ...filesUnder('deploy/lib')].concat(
    readdirSync(path.join(REPO, 'deploy/scripts')).map((f) => `deploy/scripts/${f}`),
    readdirSync(path.join(REPO, 'deploy/lib')).map((f) => `deploy/lib/${f}`),
  ))
    for (const m of read(sh).matchAll(/\btsx ((?:src|scripts|db|deploy)\/[\w/.-]+\.ts)\b/g)) found.add(m[1]!)
  for (const f of ['src', 'scripts', 'db', 'deploy'].flatMap(filesUnder))
    if (/process\.argv\[1\]/.test(read(f)) && /\bmain\(/.test(read(f))) found.add(f)
  return [...found].sort()
}

/** Why a program's source is not wired to the loader, or undefined when it is (or reads no environment). */
export function loaderProblem(text: string): string | undefined {
  // comments do not run (a comment may well mention loadEnv())
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const readsEnv = /\bloadEnv\(|process\.env\b|loadEnvFile\(/.test(source)
  if (!readsEnv) return undefined
  const loader = source.search(/\b(?:loadRuntimeEnv|applySecretEnvironment)\(/)
  if (loader < 0) return 'reads the environment without loadRuntimeEnv() / applySecretEnvironment()'
  const direct = source.search(/\bloadEnv\(/)
  if (direct >= 0 && direct < loader) return 'calls loadEnv() before the loader'
  return undefined
}

describe('every entry point uses the loader', () => {
  const programs = discoverPrograms()

  it('discovers the programs, including the ones the services and the deploy kit run', () => {
    for (const p of [
      'src/server.ts',
      'src/worker.ts',
      'scripts/migrate.ts',
      'db/seeds/index.ts',
      'scripts/secrets-rotate.ts',
      'src/modules/auth/cli.ts',
      'deploy/lib/reset-password.ts',
      'scripts/verify-live/all.ts',
      'scripts/verify-live/aws.ts',
      'scripts/verify-live/smsgate.ts',
      'scripts/verify-live/squarespace.ts',
      'scripts/secret-env.ts',
    ])
      expect(programs, p).toContain(p)
  })

  it('each one that reads the environment calls loadRuntimeEnv() or applySecretEnvironment() first (or is a listed exemption)', () => {
    const problems = programs
      .filter((p) => !(p in EXEMPT))
      .map((p) => [p, loaderProblem(read(p))] as const)
      .filter(([, why]) => why)
      .map(([p, why]) => `${p}: ${why}`)
    expect(problems).toEqual([])
    for (const p of Object.keys(EXEMPT)) expect(programs, `stale exemption ${p}`).toContain(p)
  })

  it('the check itself catches a new entry point that calls loadEnv() without the loader, or before it', () => {
    expect(loaderProblem("const env = loadEnv()\nmain()")).toMatch(/without loadRuntimeEnv/)
    expect(loaderProblem("const url = process.env.DATABASE_URL")).toMatch(/without loadRuntimeEnv/)
    expect(loaderProblem("const a = loadEnv()\nawait applySecretEnvironment()")).toBe('calls loadEnv() before the loader')
    expect(loaderProblem("await applySecretEnvironment()\nconst env = loadEnv({ ...process.env })")).toBeUndefined()
    expect(loaderProblem("const env = await loadRuntimeEnv()")).toBeUndefined()
    expect(loaderProblem("console.log('no environment')")).toBeUndefined()
    expect(loaderProblem("// what the app sees after loadEnv()\nconsole.log('x')")).toBeUndefined()
  })
})

describe('real processes read the secret (local Secrets Manager endpoint)', () => {
  const sm = new FakeSecretsHttp()
  let aws: Record<string, string>
  const dir = tempDir('oasis-secret-ep-')
  const dbUrl = testDatabaseUrl()
  const password = decodeURIComponent(new URL(dbUrl).password)

  beforeAll(async () => {
    aws = await sm.start()
    sm.secrets.set('oasis/test/app', JSON.stringify({ DATABASE_URL: dbUrl }))
    sm.secrets.set('oasis/test/denied', 'DENY')
  })
  afterAll(async () => {
    await sm.stop()
    dir.cleanup()
  })

  // cwd is an empty directory, so no .env supplies DATABASE_URL: it can only come from the secret
  const run = (file: string, args: string[], env: Record<string, string>) =>
    sh(TSX, [path.join(REPO, file), ...args], { ...aws, DATABASE_URL: undefined, DATABASE_URL_TEST: undefined, ...env }, undefined, dir.dir)

  it('pnpm migrate status connects with the DATABASE_URL from the secret and prints no value of it', async () => {
    const r = await run('scripts/migrate.ts', ['status'], { OASIS_SECRET_ID: 'oasis/test/app' })
    expect(r.out).toContain('environment: 1 setting(s) from Secrets Manager secret oasis/test/app (us-east-1)')
    expect(r.out).toMatch(/^ {2}(applied|pending) {2}\d{14}_/m)
    expect(r.out).not.toContain(dbUrl)
    if (password) expect(r.out).not.toContain(password)
    expect(sm.requests.filter((q) => q.secretId === 'oasis/test/app').length).toBeGreaterThanOrEqual(1)
  })

  it('a refused or missing secret stops the program with the clear line, before anything connects', async () => {
    const denied = await run('scripts/migrate.ts', ['status'], { OASIS_SECRET_ID: 'oasis/test/denied' })
    expect(denied.code).not.toBe(0)
    expect(denied.out).toContain('access denied reading secret "oasis/test/denied" in us-east-1: the runtime identity needs secretsmanager:GetSecretValue')
    const missing = await run('scripts/secrets-rotate.ts', [], { OASIS_SECRET_ID: 'oasis/test/missing' })
    expect(missing.code).toBe(2)
    expect(missing.out).toContain('secret "oasis/test/missing" in us-east-1 does not exist')
  })

  it('without OASIS_SECRET_ID nothing is fetched', async () => {
    const before = sm.requests.length
    const r = await run('scripts/migrate.ts', ['status'], {})
    expect(r.out).toContain('DATABASE_URL (or DATABASE_URL_TEST with --test) is not set')
    expect(sm.requests.length).toBe(before)
  })
})
