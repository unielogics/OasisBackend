// tsx scripts/e2e-square/stack.ts --env <file> --dir <state dir>
//
// A disposable backend stack against the Square SANDBOX (plan "Verification", sandbox end to end): one API and one worker of
// this checkout, on the schema and pg-boss schema the env file names. The sandbox app's credentials are read at run time from
// Secrets Manager (`SANDBOX_SECRET_ID`, default oasis/sandbox/square; the AWS profile of this shell) and handed to the two child
// processes' environment only: never written to disk, never printed, never logged. Per run it generates the PIN pepper, the
// session secret, a dummy webhook URL and signature key (no public URL: the Events API catch-up brings the events) and the
// bootstrap admin password (written to <dir>/admin.json, mode 600: a login of this throwaway database only).
//
// It stays in the foreground; SIGTERM or SIGINT stops both children (their own process groups, only the PIDs it started),
// then checks that no log it kept contains the access token and exits. <dir>/stack.json holds the PIDs, ports and log paths.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

const args = process.argv.slice(2)
const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const envFile = flag('--env')
const dir = flag('--dir')
if (!envFile || !dir) {
  console.error('usage: stack.ts --env <file> --dir <state dir>')
  process.exit(2)
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

async function sandboxSecret(): Promise<Record<string, string>> {
  const id = process.env.SANDBOX_SECRET_ID ?? 'oasis/sandbox/square'
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  const out = await sm.send(new GetSecretValueCommand({ SecretId: id }))
  const doc = JSON.parse(out.SecretString ?? '{}') as Record<string, unknown>
  const pick = (k: string): string => {
    const v = doc[k]
    if (typeof v !== 'string' || !v.trim()) throw new Error(`the secret ${id} has no ${k}`)
    return v.trim()
  }
  return {
    SQUARE_ACCESS_TOKEN: pick('SQUARE_ACCESS_TOKEN'),
    SQUARE_APPLICATION_ID: pick('SQUARE_APPLICATION_ID'),
  }
}

const children: { name: string; proc: ChildProcess; log: string }[] = []
let token = ''

let stopping = false
function stop(code: number): void {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      process.kill(-c.proc.pid!, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
  setTimeout(() => {
    for (const c of children) {
      try {
        process.kill(-c.proc.pid!, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    // the logs must never hold the token
    let leaks = 0
    for (const c of children)
      if (token && fs.existsSync(c.log) && fs.readFileSync(c.log, 'utf8').includes(token)) leaks++
    for (const f of fs.readdirSync(dir!)) {
      const p = path.join(dir!, f)
      if (fs.statSync(p).isFile() && token && fs.readFileSync(p, 'utf8').includes(token)) leaks++
    }
    console.log(`stack stopped; files holding the access token: ${leaks}`)
    process.exit(leaks ? 3 : code)
  }, 4000)
}

async function main(): Promise<void> {
  const base = readEnvFile(envFile!)
  const sq = await sandboxSecret()
  token = sq.SQUARE_ACCESS_TOKEN!
  const adminPassword = randomBytes(18).toString('base64url')
  const admin = { email: base.BOOTSTRAP_ADMIN_EMAIL ?? 'q4-admin@oasis.test', password: adminPassword }
  fs.writeFileSync(path.join(dir!, 'admin.json'), JSON.stringify(admin), { mode: 0o600 })
  const pinPepper = randomBytes(32).toString('base64')
  fs.writeFileSync(path.join(dir!, 'pepper.txt'), pinPepper, { mode: 0o600 }) // the test PIN hasher of this run (driver)

  // the parent's AWS settings stay with the parent: the app needs no AWS here (email, SMS and storage are local)
  const inherited: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(inherited)) if (/^AWS_|^SANDBOX_SECRET_ID$/.test(k)) delete inherited[k]
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...base,
    NODE_ENV: 'development',
    HOOKS_PORT: '0',
    SESSION_SECRET: randomBytes(32).toString('base64'),
    PIN_PEPPER: pinPepper,
    BOOTSTRAP_ADMIN_EMAIL: admin.email,
    BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
    SQUARE_PROVIDER: 'live',
    SQUARE_ENVIRONMENT: 'sandbox',
    SQUARE_WEBHOOK_URL: `https://q4-e2e-${randomBytes(4).toString('hex')}.invalid/hooks/square`,
    SQUARE_WEBHOOK_SIGNATURE_KEY: randomBytes(24).toString('base64url'),
    ...sq,
  }
  const tsx = path.resolve('node_modules/.bin/tsx')
  const start = (name: string, entry: string, extra: NodeJS.ProcessEnv): void => {
    const log = path.join(dir!, `${name}.log`)
    const fd = fs.openSync(log, 'a', 0o600)
    const proc = spawn(tsx, [entry], { detached: true, stdio: ['ignore', fd, fd], env: { ...env, ...extra } })
    children.push({ name, proc, log })
    proc.on('exit', (code, sig) => {
      console.log(`${name} exited (${code ?? sig})`)
      stop(1)
    })
  }
  start('api', 'src/server.ts', {})
  start('worker', 'src/worker.ts', {})
  fs.writeFileSync(
    path.join(dir!, 'stack.json'),
    JSON.stringify({
      launcher: process.pid,
      api: children[0]!.proc.pid,
      worker: children[1]!.proc.pid,
      port: base.PORT,
      logs: children.map((c) => c.log),
    }),
  )
  console.log(
    `stack up: launcher ${process.pid}, api ${children[0]!.proc.pid}, worker ${children[1]!.proc.pid}, port ${base.PORT}`,
  )
}

process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(0))
main().catch((e: unknown) => {
  console.error(`stack: ${e instanceof Error ? e.message : String(e)}`)
  stop(1)
})
