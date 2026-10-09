// pnpm aws:provision  -  creates (or checks) everything Oasis needs in AWS, plan first. See docs/aws-setup.md.
//
//   pnpm aws:provision --profile oasis-admin --dashboard-origin https://oasis.example.com \
//     --runtime role --private-ip 172.31.5.10          # prints the plan; add --apply to make the changes
//   later, once there is a sender and a public host: the same command plus --sender oasisautospa.com --hooks-url https://.../hooks/ses
//
// Refuses to run without --profile <name> or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in the environment, and never asks the EC2
// instance metadata service for anything (AWS_EC2_METADATA_DISABLED=true is set before any client exists; the instance is found by
// --instance-id or --private-ip). Describes before it creates, never deletes, and with --runtime user writes the app's access key only
// to --out (mode 0600); the key is never printed.
import { parseArgs } from 'node:util'
import { EC2Client } from '@aws-sdk/client-ec2'
import { IAMClient } from '@aws-sdk/client-iam'
import { S3Client } from '@aws-sdk/client-s3'
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { SNSClient } from '@aws-sdk/client-sns'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import type { ProvisionSpec, Runtime, Sender } from './lib/documents.js'
import { ProvisionError, applyPlan, buildPlan, envLines, renderPlan, type Clients, type PlanOptions } from './lib/provision.js'

export const HELP = `pnpm aws:provision [options]

Creates or checks the Oasis AWS resources: the photos and backups buckets, the Secrets Manager secret holding the app's environment,
the least-privilege policy <prefix>-app-runtime and the identity the app runs as (the instance role, or an IAM user with a key), and,
once --sender is given, the SES identity, configuration set and SNS feedback topic (with the HTTPS subscription to /hooks/ses).
Prints the plan; changes nothing without --apply. Exit code 0 = done (or nothing to do), 1 = AWS refused or a conflict, 2 = usage.

Credentials (one of, required):
  --profile NAME                 a profile in ~/.aws/config (the operator's setup key)
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN) in the environment

Options:
  --dashboard-origin URL         browser origin allowed to upload photos (repeatable; re-run with the full list to change it) [required]
  --secret-id NAME               the environment secret, OASIS_SECRET_ID (default oasis/prod/app); created empty, never overwritten
  --runtime role|user            role (default, recommended): IAM role <prefix>-app-role + instance profile <prefix>-app-profile,
                                 associated with the instance below; user: IAM user <prefix>-app and an access key written to --out
  --instance-id ID | --private-ip ADDRESS   runtime=role: the app's EC2 instance (found with ec2:DescribeInstances, never metadata)
  --replace-instance-profile     replace an instance profile that is already associated with that instance
  --out FILE                     runtime=user: where the oasis-app access key is written (AWS credentials file, mode 0600; new file)
  --sender ADDRESS|DOMAIN        the SES identity: an address (no-reply@x.com) or a domain (x.com, DKIM records printed). Optional:
                                 without it nothing of SES/SNS is made; re-run with it later
  --hooks-url URL                public https URL of POST /hooks/ses (with --sender); without it no subscription is made
  --region REGION                default us-east-1
  --name-prefix PREFIX           default oasis (the temporary setup policy only covers oasis-*)
  --key-prefix PREFIX            photo key prefix, S3_KEY_PREFIX (default prod/)
  --photo-retention-days N       photos lifecycle expiry (default 760: the 24-month retention job decides first)
  --backup-retention-days N      backups lifecycle expiry (default 400: 12 monthly dumps plus margin)
  --sandbox-recipient ADDRESS    verify this address while SES is in the sandbox (repeatable; joins the send policy; with --sender)
  --new-access-key               runtime=user: create a second key for rotation although one exists
  --request-ses-production       submit the SES production-access request (needs --website-url and --use-case)
  --website-url URL, --use-case TEXT, --contact-email ADDRESS (repeatable)
  --apply                        make the changes
`

export interface MainDeps {
  env: Record<string, string | undefined>
  log: (line: string) => void
  /** Builds the SDK clients (tests replace the transport with mocks). */
  clients?: (config: { region: string; profile?: string }) => Clients
  /** Waits between retries while IAM propagates a new instance profile (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

class UsageError extends Error {}

const defaultClients = (cfg: { region: string; profile?: string }): Clients => {
  const base = { region: cfg.region, ...(cfg.profile ? { profile: cfg.profile } : {}) }
  return {
    s3: new S3Client(base),
    ses: new SESv2Client(base),
    sns: new SNSClient(base),
    iam: new IAMClient({ ...base, region: 'us-east-1' }),
    sts: new STSClient(base),
    sm: new SecretsManagerClient(base),
    ec2: new EC2Client(base),
  }
}

function parseSender(raw: string): Sender {
  const v = raw.trim().toLowerCase()
  if (v.includes('@')) {
    if (!/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) throw new UsageError(`--sender "${raw}" is not an email address`)
    return { kind: 'address', identity: v, domain: v.split('@')[1]! }
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) throw new UsageError(`--sender "${raw}" is neither an address nor a domain`)
  return { kind: 'domain', identity: v, domain: v }
}

/** Before the domain exists the dashboard is reached over the tailnet or a private address, by http. */
function privateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.ts.net')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

function origin(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UsageError(`--dashboard-origin "${raw}" is not a URL`)
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && privateHost(u.hostname)))
    throw new UsageError(`--dashboard-origin ${raw}: https only (http only for localhost, a private or tailnet address, or a *.ts.net name)`)
  return u.origin
}

const int = (v: string | undefined, name: string, def: number, min: number): number => {
  if (v === undefined) return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}`)
  return n
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const { log } = deps
  let parsed
  try {
    parsed = parseArgs({
      // `pnpm aws:provision -- --flag` hands the separator through
      args: argv[0] === '--' ? argv.slice(1) : argv,
      allowPositionals: false,
      options: {
        help: { type: 'boolean' },
        apply: { type: 'boolean' },
        profile: { type: 'string' },
        region: { type: 'string' },
        'name-prefix': { type: 'string' },
        'dashboard-origin': { type: 'string', multiple: true },
        sender: { type: 'string' },
        'hooks-url': { type: 'string' },
        out: { type: 'string' },
        'key-prefix': { type: 'string' },
        'photo-retention-days': { type: 'string' },
        'backup-retention-days': { type: 'string' },
        'sandbox-recipient': { type: 'string', multiple: true },
        'new-access-key': { type: 'boolean' },
        'request-ses-production': { type: 'boolean' },
        'website-url': { type: 'string' },
        'use-case': { type: 'string' },
        'contact-email': { type: 'string', multiple: true },
        'secret-id': { type: 'string' },
        runtime: { type: 'string' },
        'instance-id': { type: 'string' },
        'private-ip': { type: 'string' },
        'replace-instance-profile': { type: 'boolean' },
      },
    })
  } catch (e) {
    log(`aws:provision: ${(e as Error).message}\n\n${HELP}`)
    return 2
  }
  const a = parsed.values
  if (a.help) {
    log(HELP)
    return 0
  }

  // never let the SDK fall back to the instance metadata service, whatever else happens
  process.env.AWS_EC2_METADATA_DISABLED = 'true'
  const envKeys = !!deps.env.AWS_ACCESS_KEY_ID && !!deps.env.AWS_SECRET_ACCESS_KEY
  try {
    if (!a.profile && !envKeys)
      throw new UsageError(
        'refusing to run without credentials chosen on purpose: pass --profile <name> (the temporary setup user) or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      )
    if (a.profile && envKeys)
      throw new UsageError('both --profile and AWS_ACCESS_KEY_ID are set; unset one so it is clear which identity acts')
    if (!a['dashboard-origin']?.length) throw new UsageError('--dashboard-origin is required (the dashboard URL, repeatable)')
    const runtime = (a.runtime ?? 'role') as Runtime
    if (runtime !== 'role' && runtime !== 'user') throw new UsageError('--runtime must be role or user')
    const secretId = a['secret-id'] ?? 'oasis/prod/app'
    if (!/^[A-Za-z0-9/_+=.@-]{1,512}$/.test(secretId) || /-[A-Za-z0-9]{6}$/.test(secretId))
      throw new UsageError('--secret-id must be a secret name such as oasis/prod/app (not an ARN, and not ending in a hyphen and six characters, which AWS reserves for its suffix)')
    if (runtime === 'role' && (a.out || a['new-access-key'])) throw new UsageError('--out and --new-access-key are for --runtime user (the role needs no key)')
    if (runtime === 'user' && (a['instance-id'] || a['private-ip'] || a['replace-instance-profile']))
      throw new UsageError('--instance-id, --private-ip and --replace-instance-profile are for --runtime role')
    if (a['instance-id'] && a['private-ip']) throw new UsageError('give --instance-id or --private-ip, not both')
    if (a['instance-id'] && !/^i-[0-9a-f]{8,17}$/.test(a['instance-id'])) throw new UsageError(`--instance-id ${a['instance-id']} is not an instance id (i-...)`)
    if (a['private-ip'] && !/^\d{1,3}(\.\d{1,3}){3}$/.test(a['private-ip'])) throw new UsageError(`--private-ip ${a['private-ip']} is not an IPv4 address`)
    if (a['replace-instance-profile'] && !a['instance-id'] && !a['private-ip']) throw new UsageError('--replace-instance-profile needs --instance-id or --private-ip')
    if (!a.sender && (a['hooks-url'] || a['sandbox-recipient']?.length || a['request-ses-production']))
      throw new UsageError('--hooks-url, --sandbox-recipient and --request-ses-production need --sender (email comes last: leave them out for now)')
    const prefix = a['name-prefix'] ?? 'oasis'
    if (!/^[a-z0-9][a-z0-9-]{1,19}$/.test(prefix)) throw new UsageError('--name-prefix: 2 to 20 lowercase letters, digits or hyphens')
    const keyPrefix = a['key-prefix'] ?? 'prod/'
    if (keyPrefix !== '' && !/^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*\/$/.test(keyPrefix))
      throw new UsageError('--key-prefix must be empty or like prod/ (ending in /)')
    const region = a.region ?? 'us-east-1'
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new UsageError(`--region "${region}" is not an AWS region`)
    let hooksUrl: string | undefined
    if (a['hooks-url']) {
      const u = new URL(a['hooks-url'])
      if (u.protocol !== 'https:' || !u.pathname.endsWith('/hooks/ses'))
        throw new UsageError('--hooks-url must be the public https URL of /hooks/ses')
      hooksUrl = u.href
    }
    const sandboxRecipients = (a['sandbox-recipient'] ?? []).map((r) => {
      const s = parseSender(r)
      if (s.kind !== 'address') throw new UsageError(`--sandbox-recipient ${r} must be an address`)
      return s.identity
    })
    let requestProduction: PlanOptions['requestProduction']
    if (a['request-ses-production']) {
      if (!a['website-url'] || !a['use-case'])
        throw new UsageError('--request-ses-production needs --website-url and --use-case (AWS reads them)')
      requestProduction = { websiteUrl: new URL(a['website-url']).href, useCase: a['use-case'], contactEmails: a['contact-email'] ?? [] }
    }
    const sender = a.sender ? parseSender(a.sender) : undefined
    const dashboardOrigins = a['dashboard-origin'].map(origin)
    const photoRetentionDays = int(a['photo-retention-days'], 'photo-retention-days', 760, 1)
    const backupRetentionDays = int(a['backup-retention-days'], 'backup-retention-days', 400, 1)

    const clients = (deps.clients ?? defaultClients)({ region, ...(a.profile ? { profile: a.profile } : {}) })
    const who = await clients.sts.send(new GetCallerIdentityCommand({}))
    if (!who.Account) throw new ProvisionError('STS returned no account id')
    log(`identity: ${who.Arn ?? '(unknown)'} (account ${who.Account})`)
    if (prefix !== 'oasis') log(`warning: the temporary setup policy in docs/aws-setup.md only covers names starting with "oasis-"`)
    const spec: ProvisionSpec = {
      region,
      account: who.Account,
      prefix,
      ...(sender ? { sender } : {}),
      secretId,
      runtime,
      dashboardOrigins,
      ...(hooksUrl ? { hooksUrl } : {}),
      keyPrefix,
      photoRetentionDays,
      backupRetentionDays,
      sandboxRecipients,
    }
    const opts: PlanOptions = {
      ...(a.out ? { out: a.out } : {}),
      ...(a['instance-id'] ? { instance: { id: a['instance-id'] } } : a['private-ip'] ? { instance: { privateIp: a['private-ip'] } } : {}),
      ...(a['replace-instance-profile'] ? { replaceInstanceProfile: true } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(a['new-access-key'] ? { newAccessKey: true } : {}),
      ...(requestProduction ? { requestProduction } : {}),
    }
    const plan = await buildPlan(clients, spec, opts)
    for (const line of renderPlan(plan)) log(line)
    const keyStep = plan.steps.find((s) => s.id === 'iam.access-key')
    if (a.apply && keyStep?.change === 'create' && !keyStep.apply) throw new UsageError('an access key is to be created: pass --out <file>')

    if (a.apply) {
      log('')
      const n = await applyPlan(plan, log)
      log(`applied ${n} change(s)`)
      for (const r of plan.results) log(`  ${r}`)
      log('Run the same command without --apply to confirm that nothing is left to change.')
    } else if (plan.steps.some((s) => s.apply)) log('Nothing was changed. Run again with --apply to make these changes.')

    if (plan.dns.length && sender) {
      log('')
      log(`DNS records for whoever runs the DNS of ${sender.domain}:`)
      for (const d of plan.dns) log(`  ${d}`)
    }
    log('')
    log('Application settings (not secret: /etc/oasis/common.env), then restart oasis-api and oasis-worker:')
    for (const e of envLines(spec)) log(`  ${e}`)
    log(`Secret settings go into ${secretId} with: pnpm secrets:push --profile <operator profile> --secret-id ${secretId} --from <file> --apply`)
    return 0
  } catch (e) {
    if (e instanceof UsageError) {
      log(`aws:provision: ${e.message}`)
      return 2
    }
    if (e instanceof ProvisionError) {
      log(`aws:provision: ${e.message}`)
      return 1
    }
    const x = e as { name?: string; message?: string }
    log(`aws:provision: AWS refused: ${x.name ?? 'Error'}: ${x.message ?? String(e)}`)
    return 1
  }
}

if (process.argv[1]?.endsWith('provision.ts')) {
  main(process.argv.slice(2), { env: process.env, log: (l) => console.log(l) }).then((code) => process.exit(code))
}
