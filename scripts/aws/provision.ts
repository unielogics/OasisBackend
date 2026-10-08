// pnpm aws:provision  -  creates (or checks) everything Oasis needs in AWS, plan first. See docs/aws-setup.md.
//
//   pnpm aws:provision --profile oasis-setup --sender oasisautospa.com \
//     --dashboard-origin https://oasis.example.com --hooks-url https://oasis.example.com/hooks/ses \
//     --out /root/oasis-app.key            # prints the plan; add --apply to make the changes
//
// Refuses to run without --profile <name> or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in the environment, and never asks the EC2
// instance metadata service for credentials (AWS_EC2_METADATA_DISABLED=true is set before any client exists). Describes before it
// creates, never deletes, and writes the app's access key only to --out (mode 0600); the key is never printed.
import { parseArgs } from 'node:util'
import { IAMClient } from '@aws-sdk/client-iam'
import { S3Client } from '@aws-sdk/client-s3'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { SNSClient } from '@aws-sdk/client-sns'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import type { ProvisionSpec, Sender } from './lib/documents.js'
import { ProvisionError, applyPlan, buildPlan, envLines, renderPlan, type Clients, type PlanOptions } from './lib/provision.js'

export const HELP = `pnpm aws:provision [options]

Creates or checks the Oasis AWS resources: the photos and backups buckets, the SES identity, configuration set and SNS feedback topic
(with the HTTPS subscription to /hooks/ses), and the IAM user <prefix>-app with its least-privilege policy and one access key.
Prints the plan; changes nothing without --apply. Exit code 0 = done (or nothing to do), 1 = AWS refused or a conflict, 2 = usage.

Credentials (one of, required):
  --profile NAME                 a profile in ~/.aws/config (the temporary setup user)
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN) in the environment

Options:
  --sender ADDRESS|DOMAIN        the SES identity: an address (no-reply@x.com) or a domain (x.com, DKIM records printed)   [required]
  --dashboard-origin URL         browser origin allowed to upload photos (repeatable)                                    [required]
  --hooks-url URL                public https URL of POST /hooks/ses; without it no subscription is made
  --out FILE                     where the oasis-app access key is written (mode 0600; must not exist)
  --region REGION                default us-east-1
  --name-prefix PREFIX           default oasis (the temporary setup policy only covers oasis-*)
  --key-prefix PREFIX            photo key prefix, S3_KEY_PREFIX (default prod/)
  --photo-retention-days N       photos lifecycle expiry (default 760: the 24-month retention job decides first)
  --backup-retention-days N      backups lifecycle expiry (default 400: 12 monthly dumps plus margin)
  --sandbox-recipient ADDRESS    verify this address while SES is in the sandbox (repeatable; joins the send policy)
  --new-access-key               create a second key for rotation although one exists
  --request-ses-production       submit the SES production-access request (needs --website-url and --use-case)
  --website-url URL, --use-case TEXT, --contact-email ADDRESS (repeatable)
  --apply                        make the changes
`

export interface MainDeps {
  env: Record<string, string | undefined>
  log: (line: string) => void
  /** Builds the SDK clients (tests replace the transport with mocks). */
  clients?: (config: { region: string; profile?: string }) => Clients
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

function origin(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UsageError(`--dashboard-origin "${raw}" is not a URL`)
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new UsageError(`--dashboard-origin ${raw}: https only (or localhost)`)
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
    if (!a.sender) throw new UsageError('--sender is required (an address or a domain)')
    if (!a['dashboard-origin']?.length) throw new UsageError('--dashboard-origin is required (the dashboard URL, repeatable)')
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
    const sender = parseSender(a.sender)
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
      sender,
      dashboardOrigins,
      ...(hooksUrl ? { hooksUrl } : {}),
      keyPrefix,
      photoRetentionDays,
      backupRetentionDays,
      sandboxRecipients,
    }
    const opts: PlanOptions = {
      ...(a.out ? { out: a.out } : {}),
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

    if (plan.dns.length) {
      log('')
      log(`DNS records for whoever runs the DNS of ${sender.domain}:`)
      for (const d of plan.dns) log(`  ${d}`)
    }
    log('')
    log('Application settings (/etc/oasis/common.env), then restart oasis-api and oasis-worker:')
    for (const e of envLines(spec)) log(`  ${e}`)
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
