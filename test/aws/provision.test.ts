// pnpm aws:provision: plan first, apply only with --apply, idempotent on re-run, never deletes, the key only in --out (0600), and
// every call it makes allowed by the temporary setup policy documented in docs/aws-setup.md. The AWS account is an in-memory fake
// behind the real SDK client classes (aws-sdk-client-mock). The first suites run the runtime=user flow with a sender (the original
// shape); the later ones cover the default runtime=role, provisioning without a sender, and the environment secret.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../../scripts/aws/provision.js'
import {
  backupsLifecycle,
  names,
  photosCors,
  photosLifecycle,
  ROLE_TRUST_POLICY,
  runtimePolicy,
  secretArnPattern,
  tlsOnlyBucketPolicy,
  topicPolicy,
  TOPIC_DELIVERY_POLICY,
  type ProvisionSpec,
} from '../../scripts/aws/lib/documents.js'
import { allowedBy, iamCallsOf, type PolicyStatement } from '../../scripts/aws/lib/iam.js'
import { ACCOUNT, FakeAws } from './helpers/fake-aws.js'

const PHOTOS = `oasis-photos-${ACCOUNT}`
const BACKUPS = `oasis-backups-${ACCOUNT}`
const TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:oasis-ses-events`
const POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/oasis-app-runtime`
const HOOKS = 'https://oasis.example.com/hooks/ses'
const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:oasis/prod/app-Ab12Cd`
const PROFILE_ARN = `arn:aws:iam::${ACCOUNT}:instance-profile/oasis-app-profile`

let fake: FakeAws
let dir: string
const allSent: Array<{ command: string; input: Record<string, unknown> }> = []

beforeEach(() => {
  process.env.AWS_EC2_METADATA_DISABLED = 'true'
  fake = new FakeAws()
  dir = mkdtempSync(path.join(tmpdir(), 'oasis-provision-'))
})
afterEach(() => {
  allSent.push(...fake.sent)
  fake.restore()
  rmSync(dir, { recursive: true, force: true })
})

const base = ['--profile', 'oasis-setup', '--runtime', 'user', '--sender', 'oasisautospa.com', '--dashboard-origin', 'https://oasis.example.com', '--hooks-url', HOOKS]

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  const lines: string[] = []
  const factory = fake.install()
  let built = 0
  const code = await main(args, {
    env,
    log: (l) => lines.push(l),
    sleep: async () => undefined,
    clients: (cfg) => {
      built += 1
      return factory(cfg)
    },
  })
  fake.restore()
  return { code, out: lines.join('\n'), built }
}

const spec = (over: Partial<ProvisionSpec> = {}): ProvisionSpec => ({
  region: 'us-east-1',
  account: ACCOUNT,
  prefix: 'oasis',
  sender: { kind: 'domain', identity: 'oasisautospa.com', domain: 'oasisautospa.com' },
  secretId: 'oasis/prod/app',
  runtime: 'user',
  dashboardOrigins: ['https://oasis.example.com'],
  hooksUrl: HOOKS,
  keyPrefix: 'prod/',
  photoRetentionDays: 760,
  backupRetentionDays: 400,
  sandboxRecipients: [],
  ...over,
})

describe('refusals', () => {
  it('refuses to run without --profile or explicit key variables, before any AWS client exists', async () => {
    const r = await run(['--sender', 'oasisautospa.com', '--dashboard-origin', 'https://oasis.example.com'])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/refusing to run without credentials chosen on purpose: pass --profile <name>/)
    expect(r.built).toBe(0)
    expect(fake.sent).toEqual([])
  })

  it('accepts the pnpm "--" separator', async () => {
    const r = await run(['--', ...base])
    expect(r.code, r.out).toBe(0)
  })

  it('refuses an ambiguous identity (profile and key variables together)', async () => {
    const r = await run(base, { AWS_ACCESS_KEY_ID: 'AKIAENVKEY', AWS_SECRET_ACCESS_KEY: 'secret' })
    expect(r.code).toBe(2)
    expect(r.built).toBe(0)
  })

  it('accepts explicit key variables instead of a profile, and always disables the instance metadata service', async () => {
    delete process.env.AWS_EC2_METADATA_DISABLED
    const r = await run(base.slice(2), { AWS_ACCESS_KEY_ID: 'AKIAENVKEY', AWS_SECRET_ACCESS_KEY: 'secret' })
    expect(r.out).not.toMatch(/instance metadata|169\.254/)
    expect(r.code).toBe(0)
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true')
  })

  it.each([
    [['--sender', 'not a sender'], /--sender/],
    [['--dashboard-origin', 'http://oasis.example.com'], /https only/],
    [['--dashboard-origin', 'http://203.0.113.9'], /https only/],
    [['--hooks-url', 'https://oasis.example.com/hooks/smsgate'], /--hooks-url/],
    [['--key-prefix', 'prod'], /--key-prefix/],
    [['--request-ses-production'], /--website-url and --use-case/],
    [['--sandbox-recipient', 'example.com'], /must be an address/],
  ])('rejects bad input %j', async (extra, msg) => {
    const r = await run([...base, ...extra])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(msg)
    expect(fake.mutations()).toEqual([])
  })

  it('stops when a bucket name is taken by another account', async () => {
    fake.foreignBuckets.add(PHOTOS)
    const r = await run([...base, '--apply', '--out', path.join(dir, 'k')])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/exists but this identity may not use it/)
    expect(fake.mutations()).toEqual([])
  })
})

describe('plan, apply, re-run', () => {
  it('on an empty account the plan lists every resource, prints every document, and changes nothing', async () => {
    const r = await run(base)
    expect(r.code).toBe(0)
    expect(fake.mutations()).toEqual([])
    for (const line of [
      `identity: arn:aws:iam::${ACCOUNT}:user/oasis-setup-temp (account ${ACCOUNT})`,
      `  + S3 photos bucket ${PHOTOS}: create in us-east-1 with Object Ownership BucketOwnerEnforced (ACLs disabled)`,
      `  + S3 photos bucket ${PHOTOS}: CORS: POST, GET and HEAD from https://oasis.example.com: set the document below`,
      `  + S3 backups bucket ${BACKUPS}: versioning enabled: set the document below`,
      '  + Secrets Manager secret oasis/prod/app: create it holding an empty JSON object, with the AWS-managed key aws/secretsmanager, tagged app=oasis (pnpm secrets:push fills it)',
      '  + SES sending identity oasisautospa.com: create the domain identity with Easy DKIM (RSA 2048); the three CNAME records are printed after apply',
      `  + SNS topic oasis-ses-events: create (Standard; SES does not publish to FIFO) with the access policy and the HTTPS delivery policy below; ARN ${TOPIC}`,
      '  + SES configuration set oasis-mail: event destination oasis-sns-events: BOUNCE, COMPLAINT, DELIVERY, REJECT to oasis-ses-events',
      `  + SNS subscription oasis-ses-events -> ${HOOKS}: subscribe the HTTPS endpoint (the app confirms it itself)`,
      '  + IAM user oasis-app: create (no console password, tagged app=oasis)',
      '  + IAM policy oasis-app-runtime: create the managed policy (least privilege, below)',
      '  + IAM user oasis-app: create one access key: pass --out <file> (written with mode 0600, never printed)',
      'note: SES: the account is in the SANDBOX (only verified recipients, 200 per day)',
      'Nothing was changed. Run again with --apply to make these changes.',
      `  SES_SNS_TOPIC_ARNS=${TOPIC}`,
      `  S3_BUCKET=${PHOTOS}`,
      '  S3_KEY_PREFIX=prod/',
      `  BACKUP_S3_URI=s3://${BACKUPS}/db/`,
      '  OASIS_SECRET_ID=oasis/prod/app',
      '  # runtime=user: install the --out file as /etc/oasis/aws-credentials (root, 0600); the units hand it to the services',
      '(the secret does not exist yet: "-??????" stands for the suffix AWS appends; apply uses the real ARN)',
    ])
      expect(r.out.split('\n')).toContain(line)
    expect(r.out).toContain(JSON.stringify(runtimePolicy(spec()), null, 2))
    expect(r.out).toContain(`"Resource": "arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:oasis/prod/app-??????"`)
    expect(r.out).toContain(JSON.stringify(tlsOnlyBucketPolicy(PHOTOS), null, 2))
  })

  it('--apply without --out stops before changing anything when a key is to be created', async () => {
    const r = await run([...base, '--apply'])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/pass --out <file>/)
    expect(fake.mutations()).toEqual([])
  })

  it('applies, writes the key only to --out (0600), prints the DKIM records, and a re-run finds nothing to do', async () => {
    const out = path.join(dir, 'oasis-app.key')
    const first = await run([...base, '--out', out, '--apply'])
    expect(first.code, first.out).toBe(0)

    const b = fake.buckets.get(PHOTOS)!
    expect(b.pab).toEqual({ BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true })
    expect(b.ownership).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] })
    expect(b.cors).toEqual(photosCors(['https://oasis.example.com']).CORSRules)
    expect(b.life).toEqual(photosLifecycle(spec()).Rules)
    expect(JSON.parse(b.policy!)).toEqual(tlsOnlyBucketPolicy(PHOTOS))
    expect(fake.buckets.get(BACKUPS)).toMatchObject({ versioning: 'Enabled', life: backupsLifecycle(spec()).Rules })
    expect(JSON.parse(fake.topics.get(TOPIC)!.attrs.Policy!)).toEqual(topicPolicy(spec()))
    expect(JSON.parse(fake.topics.get(TOPIC)!.attrs.DeliveryPolicy!)).toEqual(TOPIC_DELIVERY_POLICY)
    expect(fake.topics.get(TOPIC)!.subs).toEqual([{ Protocol: 'https', Endpoint: HOOKS, SubscriptionArn: 'PendingConfirmation' }])
    expect(fake.configSets.get('oasis-mail')!.get('oasis-sns-events')).toEqual({
      Enabled: true,
      MatchingEventTypes: ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'],
      SnsDestination: { TopicArn: TOPIC },
    })
    expect(fake.users.get('oasis-app')!.attached).toEqual(new Set([POLICY_ARN]))
    // the policy grants the secret by its real ARN (apply created the secret first)
    expect(JSON.parse(decodeURIComponent(fake.policies.get(POLICY_ARN)![0]!.Document))).toEqual(runtimePolicy(spec(), SECRET_ARN))
    expect(fake.secretsManager.get('oasis/prod/app')).toEqual({ value: '{}', tags: [{ Key: 'app', Value: 'oasis' }] })

    // an AWS credentials file for /etc/oasis/aws-credentials
    const key = readFileSync(out, 'utf8')
    expect(statSync(out).mode & 0o777).toBe(0o600)
    const [id, secret] = fake.secrets.slice(-1).concat(fake.secrets.slice(-2, -1))
    expect(key).toContain(`[default]\naws_access_key_id = ${id}\naws_secret_access_key = ${secret}\n`)
    expect(key).toContain(`sudo install -o root -g root -m 0600 ${out} /etc/oasis/aws-credentials`)
    expect(first.out).not.toContain(secret!)
    expect(first.out).not.toContain(id!)
    expect(first.out).toContain(`access key ${id!.slice(0, 4)}...${id!.slice(-4)} written to ${out} (mode 0600)`)
    for (const t of ['tok1abc', 'tok2def', 'tok3ghi'])
      expect(first.out).toContain(`CNAME  ${t}._domainkey.oasisautospa.com  ->  ${t}.dkim.amazonses.com`)

    // the confirmation reached the app; the re-run is all "="
    fake.topics.get(TOPIC)!.subs[0]!.SubscriptionArn = `${TOPIC}:sub-1`
    const before = fake.sent.length
    const again = await run(base)
    expect(again.code).toBe(0)
    expect(fake.sent.slice(before).filter((s) => /^(Create|Put|Set|Subscribe|Attach|Update|Delete|Associate|Replace|AddRole)/.test(s.command))).toEqual([])
    expect(again.out).toContain('Nothing to change.')
    expect(again.out).not.toMatch(/^ {2}[+~!] /m)
    expect(again.out).toContain(`  = IAM user oasis-app: has ${id!.slice(0, 4)}...${id!.slice(-4)} (Active); pass --new-access-key to rotate`)
    // DKIM records are printed again while the domain is not verified
    expect(again.out).toContain('CNAME  tok1abc._domainkey.oasisautospa.com  ->  tok1abc.dkim.amazonses.com')

    // and applying again changes nothing, even with --out given
    const third = await run([...base, '--out', path.join(dir, 'unused.key'), '--apply'])
    expect(third.out).toContain('applied 0 change(s)')
    expect(existsSync(path.join(dir, 'unused.key'))).toBe(false)
  })

  it('never overwrites an existing --out file', async () => {
    const out = path.join(dir, 'exists.key')
    writeFileSync(out, 'keep me')
    const r = await run([...base, '--out', out, '--apply'])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/already exists/)
    expect(readFileSync(out, 'utf8')).toBe('keep me')
    expect(fake.mutations()).toEqual([])
  })
})

describe('drift and things it does not own', () => {
  async function provisioned(): Promise<void> {
    const r = await run([...base, '--out', path.join(dir, 'k1'), '--apply'])
    expect(r.code, r.out).toBe(0)
    fake.topics.get(TOPIC)!.subs[0]!.SubscriptionArn = `${TOPIC}:sub-1`
    fake.sent.length = 0
  }

  it('repairs a changed CORS rule and keeps a lifecycle rule and a policy statement someone else added', async () => {
    await provisioned()
    const b = fake.buckets.get(PHOTOS)!
    b.cors = [{ ID: 'dashboard-uploads', AllowedOrigins: ['https://old.example.com'], AllowedMethods: ['POST'], AllowedHeaders: ['*'] }]
    b.life = [...(b.life ?? []), { ID: 'someone-elses-rule', Status: 'Enabled', Filter: { Prefix: 'tmp/' }, Expiration: { Days: 3 } }]
    const pol = JSON.parse(b.policy!) as { Statement: object[] }
    pol.Statement.push({ Sid: 'AuditorRead', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${PHOTOS}/*` })
    b.policy = JSON.stringify(pol)

    const plan = await run(base)
    expect(plan.out).toContain(`  ~ S3 photos bucket ${PHOTOS}: CORS: POST, GET and HEAD from https://oasis.example.com: replace with the document below`)
    expect(plan.out).toContain(`  = S3 photos bucket ${PHOTOS}: lifecycle: photos under "prod/" expire after 760 days, unfinished uploads after 1 day: as wanted`)
    expect(plan.out).toContain(`  = S3 photos bucket ${PHOTOS}: bucket policy: deny any request without TLS: as wanted`)

    const r = await run([...base, '--apply', '--dashboard-origin', 'https://staging.oasis.example.com'])
    expect(r.code).toBe(0)
    expect(fake.mutations().map((m) => m.command)).toEqual(['PutBucketCorsCommand'])
    expect(b.cors).toEqual(photosCors(['https://oasis.example.com', 'https://staging.oasis.example.com']).CORSRules)
    expect((b.life as Array<{ ID: string }>).map((x) => x.ID)).toContain('someone-elses-rule')
    expect((JSON.parse(b.policy!) as { Statement: Array<{ Sid: string }> }).Statement.map((s) => s.Sid)).toEqual(['DenyInsecureTransport', 'AuditorRead'])
  })

  it('adds a policy version when the runtime policy changes, removing the oldest non-default one at the IAM limit of five', async () => {
    await provisioned()
    const versions = fake.policies.get(POLICY_ARN)!
    for (let i = 2; i <= 5; i++) versions.push({ VersionId: `v${i}`, Document: versions[0]!.Document, IsDefaultVersion: false, CreateDate: new Date(i * 1000) })
    const r = await run([...base, '--sandbox-recipient', 'tester@example.com', '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('  ~ IAM policy oasis-app-runtime: add a new default version with the document below')
    expect(r.out).toContain('removed the oldest non-default version v2 of oasis-app-runtime (IAM keeps at most five)')
    expect(fake.mutations().map((m) => m.command)).toEqual(['CreateEmailIdentityCommand', 'DeletePolicyVersionCommand', 'CreatePolicyVersionCommand'])
    const def = versions.find((v) => v.IsDefaultVersion)!
    expect(JSON.parse(decodeURIComponent(def.Document))).toEqual(runtimePolicy(spec({ sandboxRecipients: ['tester@example.com'] }), SECRET_ARN))
    expect(r.out).toContain('SES emailed a verification link to t***@example.com')
  })

  it('re-sends a pending subscription confirmation, and skips the subscription without --hooks-url', async () => {
    await provisioned()
    fake.topics.get(TOPIC)!.subs[0]!.SubscriptionArn = 'PendingConfirmation'
    const r = await run([...base, '--apply'])
    expect(r.out).toContain(`  ! SNS subscription oasis-ses-events -> ${HOOKS}: pending confirmation: subscribe again so SNS resends the confirmation (set SES_SNS_TOPIC_ARNS and restart the API first)`)
    expect(fake.mutations().map((m) => m.command)).toEqual(['SubscribeCommand'])
    const without = await run(base.slice(0, -2))
    expect(without.out).toContain('  - SNS subscription oasis-ses-events -> (no --hooks-url): pass --hooks-url https://<public host>/hooks/ses to subscribe the app')
  })

  it('creates a second key only with --new-access-key, and never a third', async () => {
    await provisioned()
    const r = await run([...base, '--new-access-key', '--out', path.join(dir, 'k2'), '--apply'])
    expect(r.code).toBe(0)
    expect(fake.users.get('oasis-app')!.keys).toHaveLength(2)
    expect(r.out).toMatch(/the existing AKIA\.\.\.\d{4} \(Active\) stays until you deactivate it/)
    const third = await run([...base, '--new-access-key', '--out', path.join(dir, 'k3'), '--apply'])
    expect(third.code).toBe(1)
    expect(third.out).toMatch(/already has two access keys/)
  })

  it('submits the SES production request only when asked, once', async () => {
    await provisioned()
    expect(fake.mutations()).toEqual([])
    const flags = ['--request-ses-production', '--website-url', 'https://oasis.example.com', '--use-case', 'Transactional receipts and staff invitations only.', '--contact-email', 'owner@oasisautospa.com']
    const plan = await run([...base, ...flags])
    expect(plan.out).toContain('  ! SES production access: submit the production-access request (TRANSACTIONAL, https://oasis.example.com/)')
    expect(fake.mutations()).toEqual([])
    const r = await run([...base, ...flags, '--apply'])
    expect(r.code).toBe(0)
    expect(fake.mutations()).toEqual([
      {
        service: 'ses',
        command: 'PutAccountDetailsCommand',
        input: {
          ProductionAccessEnabled: true,
          MailType: 'TRANSACTIONAL',
          WebsiteURL: 'https://oasis.example.com/',
          UseCaseDescription: 'Transactional receipts and staff invitations only.',
          ContactLanguage: 'EN',
          AdditionalContactEmailAddresses: ['owner@oasisautospa.com'],
        },
      },
    ])
    const again = await run([...base, ...flags, '--apply'])
    expect(again.out).toContain('  = SES production access: a request is already pending review')
  })
})

describe('without a sender (email and domain come last)', () => {
  const noSender = ['--profile', 'oasis-setup', '--dashboard-origin', 'https://oasis.example.com', '--runtime', 'user']

  it('creates buckets, secret, policy and identity, and touches nothing of SES or SNS', async () => {
    const r = await run([...noSender, '--out', path.join(dir, 'k'), '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(fake.sent.filter((x) => x.service === 'ses' || x.service === 'sns')).toEqual([])
    expect(r.out).toContain('  - SES and SNS: no --sender: no identity, configuration set, feedback topic or subscription, and no SES statement in the policy; re-run with --sender later')
    expect(r.out).toContain('  # email: EMAIL_PROVIDER stays sim until a sender exists (re-run with --sender, then set the SES_* lines it prints)')
    expect(r.out).not.toMatch(/EMAIL_PROVIDER=ses|DNS records/)
    const doc = JSON.parse(decodeURIComponent(fake.policies.get(POLICY_ARN)![0]!.Document)) as { Statement: Array<{ Sid: string }> }
    expect(doc.Statement.map((x) => x.Sid)).toEqual(['ReadEnvironment', 'PhotoObjects', 'PhotoHeadMissingKey', 'BackupObjects', 'BackupList'])
    expect(doc).toEqual(runtimePolicy(spec({ sender: undefined }), SECRET_ARN))
    const again = await run(noSender)
    expect(again.out).toContain('Nothing to change.')
  })

  it('refuses the email-only options without --sender', async () => {
    for (const extra of [['--hooks-url', HOOKS], ['--sandbox-recipient', 'a@example.com'], ['--request-ses-production', '--website-url', 'https://x.example.com', '--use-case', 'x']]) {
      const r = await run([...noSender, ...extra])
      expect(r.code).toBe(2)
      expect(r.out).toMatch(/need --sender \(email comes last/)
    }
  })

  it('re-running later with --sender adds SES and SNS and a new policy version with the SES statement, and keeps everything else', async () => {
    expect((await run([...noSender, '--out', path.join(dir, 'k'), '--apply'])).code).toBe(0)
    fake.sent.length = 0
    const plan = await run([...noSender, '--sender', 'oasisautospa.com', '--hooks-url', HOOKS])
    expect(plan.out).toContain('  ~ IAM policy oasis-app-runtime: add a new default version with the document below')
    expect(plan.out).toContain('  + SES sending identity oasisautospa.com: create the domain identity with Easy DKIM (RSA 2048); the three CNAME records are printed after apply')
    expect(plan.out).toContain('  = Secrets Manager secret oasis/prod/app: exists: ' + SECRET_ARN + ' (its values are never read or changed here; pnpm secrets:push fills it)')
    const r = await run([...noSender, '--sender', 'oasisautospa.com', '--hooks-url', HOOKS, '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(fake.mutations().map((m) => m.command)).toEqual([
      'CreateEmailIdentityCommand', 'CreateTopicCommand', 'CreateConfigurationSetCommand', 'CreateConfigurationSetEventDestinationCommand',
      'SubscribeCommand', 'CreatePolicyVersionCommand',
    ])
    const versions = fake.policies.get(POLICY_ARN)!
    expect(versions).toHaveLength(2)
    expect(JSON.parse(decodeURIComponent(versions.find((v) => v.IsDefaultVersion)!.Document))).toEqual(runtimePolicy(spec(), SECRET_ARN))
    expect(fake.users.get('oasis-app')!.keys).toHaveLength(1)
  })
})

describe('the environment secret', () => {
  const args = ['--profile', 'oasis-setup', '--dashboard-origin', 'https://oasis.example.com']

  it('is created empty once, and an existing secret is never read or overwritten', async () => {
    fake.secretsManager.set('oasis/prod/app', { value: '{"DATABASE_URL":"postgres://keep"}' })
    const r = await run([...args, '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(fake.secretsManager.get('oasis/prod/app')!.value).toBe('{"DATABASE_URL":"postgres://keep"}')
    expect(fake.sent.filter((x) => x.service === 'secretsmanager').map((x) => x.command)).toEqual(['DescribeSecretCommand'])
    expect(r.out).not.toContain('postgres://keep')
  })

  it('--secret-id names another secret, and the grant follows it', async () => {
    const r = await run([...args, '--secret-id', 'oasis/staging/app', '--apply'])
    expect(r.code, r.out).toBe(0)
    expect([...fake.secretsManager.keys()]).toEqual(['oasis/staging/app'])
    const doc = JSON.parse(decodeURIComponent(fake.policies.get(POLICY_ARN)![0]!.Document)) as { Statement: Array<{ Sid: string; Resource: string }> }
    expect(doc.Statement[0]).toEqual({ Sid: 'ReadEnvironment', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:oasis/staging/app-Ab12Cd` })
    expect(r.out).toContain('  OASIS_SECRET_ID=oasis/staging/app')
  })

  it('stops on a secret scheduled for deletion, notes a customer KMS key, and refuses an ARN or a suffix-like name', async () => {
    fake.secretsManager.set('oasis/prod/app', { value: '{}', deleted: true })
    let r = await run(args)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/is scheduled for deletion: restore it first/)
    fake.secretsManager.set('oasis/prod/app', { value: '{}', kmsKeyId: `arn:aws:kms:us-east-1:${ACCOUNT}:key/1234` })
    r = await run(args)
    expect(r.out).toContain(`note: oasis/prod/app is encrypted with the key arn:aws:kms:us-east-1:${ACCOUNT}:key/1234: the runtime also needs kms:Decrypt on it, which oasis-app-runtime does not grant`)
    for (const id of [`arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:oasis/prod/app`, 'oasis/prod/app-AbCdEf', 'has space']) {
      r = await run([...args, '--secret-id', id])
      expect(r.code, id).toBe(2)
    }
  })

  it('the pattern grant before creation matches only that name', () => {
    expect(secretArnPattern({ region: 'us-east-1', account: ACCOUNT, secretId: 'oasis/prod/app' })).toBe(`arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:oasis/prod/app-??????`)
  })
})

describe('runtime=role (the default): role, instance profile, association', () => {
  const args = ['--profile', 'oasis-setup', '--dashboard-origin', 'https://oasis.example.com']
  const host = (over: Partial<FakeAws['instances'][number]> = {}) =>
    fake.instances.push({ InstanceId: 'i-0123456789abcdef0', PrivateIpAddress: '172.31.5.10', State: 'running', Name: 'oasis', ...over })

  it('creates the EC2-only role with the policy, the instance profile holding it, and associates it with the instance found by private IP', async () => {
    host()
    const plan = await run([...args, '--private-ip', '172.31.5.10'])
    expect(plan.code, plan.out).toBe(0)
    for (const line of [
      '  + IAM role oasis-app-role: create, assumable only by EC2 (trust policy below), tagged app=oasis',
      '  + IAM role oasis-app-role: oasis-app-runtime attach',
      '  + IAM instance profile oasis-app-profile: create, tagged app=oasis',
      '  + IAM instance profile oasis-app-profile: add oasis-app-role',
      '  + EC2 instance profile association i-0123456789abcdef0: associate oasis-app-profile (the services then get the role\'s credentials from the instance; restart them)',
      'note: instance i-0123456789abcdef0 "oasis" (running, private IP 172.31.5.10): no instance profile associated',
      "The app's runtime policy (oasis-app-runtime, attached to the role oasis-app-role), in full:",
      '  # runtime=role: no AWS credentials anywhere on the host; the SDK uses the instance role (leave AWS_EC2_METADATA_DISABLED unset)',
    ])
      expect(plan.out.split('\n')).toContain(line)
    expect(plan.out).toContain(JSON.stringify(ROLE_TRUST_POLICY, null, 2))
    expect(fake.mutations()).toEqual([])
    expect(fake.users.size).toBe(0)

    fake.profilePropagationFailures = 2 // EC2 does not see the new profile for a moment
    const r = await run([...args, '--private-ip', '172.31.5.10', '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(JSON.parse(fake.roles.get('oasis-app-role')!.trust)).toEqual(ROLE_TRUST_POLICY)
    expect(fake.roles.get('oasis-app-role')!.attached).toEqual(new Set([POLICY_ARN]))
    expect(fake.profiles.get('oasis-app-profile')).toEqual({ roles: ['oasis-app-role'] })
    expect(fake.associations).toEqual([{ AssociationId: expect.any(String), InstanceId: 'i-0123456789abcdef0', Arn: PROFILE_ARN, State: 'associated' }])
    expect(fake.sent.filter((x) => x.command === 'AssociateIamInstanceProfileCommand')).toHaveLength(3)
    expect(fake.users.size).toBe(0) // no user, no key on disk
    expect(r.out).toContain('oasis-app-profile associated with i-0123456789abcdef0')

    const again = await run([...args, '--instance-id', 'i-0123456789abcdef0'])
    expect(again.out).toContain('  = EC2 instance profile association i-0123456789abcdef0: oasis-app-profile is associated')
    expect(again.out).toContain('Nothing to change.')
  })

  it('never replaces an instance profile that is already associated unless asked, and says what is associated', async () => {
    host()
    fake.associations.push({ AssociationId: 'iip-assoc-0aaa', InstanceId: 'i-0123456789abcdef0', Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/dev-box`, State: 'associated' })
    const r = await run([...args, '--instance-id', 'i-0123456789abcdef0', '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`  - EC2 instance profile association i-0123456789abcdef0: another instance profile is associated (arn:aws:iam::${ACCOUNT}:instance-profile/dev-box); not replaced without --replace-instance-profile`)
    expect(r.out).toContain(`note: instance i-0123456789abcdef0 "oasis" (running, private IP 172.31.5.10): instance profile arn:aws:iam::${ACCOUNT}:instance-profile/dev-box is associated (iip-assoc-0aaa)`)
    expect(fake.associations[0]!.Arn).toBe(`arn:aws:iam::${ACCOUNT}:instance-profile/dev-box`)
    expect(fake.sent.filter((x) => /Associate|Replace/.test(x.command) && !x.command.startsWith('Describe'))).toEqual([])

    const replaced = await run([...args, '--instance-id', 'i-0123456789abcdef0', '--replace-instance-profile', '--apply'])
    expect(replaced.code, replaced.out).toBe(0)
    expect(replaced.out).toContain(`  ~ EC2 instance profile association i-0123456789abcdef0: replace arn:aws:iam::${ACCOUNT}:instance-profile/dev-box (iip-assoc-0aaa) with oasis-app-profile`)
    expect(fake.associations).toEqual([{ AssociationId: 'iip-assoc-0aaa', InstanceId: 'i-0123456789abcdef0', Arn: PROFILE_ARN, State: 'associated' }])
  })

  it('without an instance it creates role and profile and skips the association; it never asks instance metadata', async () => {
    const r = await run([...args, '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('  - EC2 instance profile association: pass --instance-id i-... or --private-ip <address> to associate oasis-app-profile with the app host (instance metadata is never read to find it)')
    expect(fake.sent.filter((x) => x.service === 'ec2')).toEqual([])
    expect(fake.profiles.has('oasis-app-profile')).toBe(true)
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true')
  })

  it('stops when the instance cannot be identified exactly', async () => {
    let r = await run([...args, '--private-ip', '172.31.5.10'])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/--private-ip 172\.31\.5\.10: no instance has this private address/)
    host()
    host({ InstanceId: 'i-0fedcba9876543210', Name: 'other-vpc' })
    r = await run([...args, '--private-ip', '172.31.5.10'])
    expect(r.out).toMatch(/matches 2 instances .*i-0123456789abcdef0.*i-0fedcba9876543210.*: pass --instance-id/)
    r = await run([...args, '--instance-id', 'i-00000000000000000'])
    expect(r.out).toMatch(/--instance-id i-00000000000000000: no such instance/)
    expect(fake.mutations()).toEqual([])
  })

  it('repairs a role trust policy someone widened, refuses a profile holding another role, and notes a leftover app user', async () => {
    host()
    expect((await run([...args, '--private-ip', '172.31.5.10', '--apply'])).code).toBe(0)
    fake.roles.get('oasis-app-role')!.trust = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' }] })
    fake.users.set('oasis-app', { attached: new Set([POLICY_ARN]), keys: [{ AccessKeyId: 'AKIAOLDKEY000000', Status: 'Active' }] })
    fake.sent.length = 0
    const r = await run([...args, '--private-ip', '172.31.5.10', '--apply'])
    expect(r.out).toContain('  ~ IAM role oasis-app-role: replace the trust policy with the one below (only EC2 may assume the role)')
    expect(r.out).toMatch(/note: the IAM user oasis-app exists from a runtime=user setup: once the services run on the role, remove \/etc\/oasis\/aws-credentials and deactivate its access key/)
    expect(fake.mutations().map((m) => m.command)).toEqual(['UpdateAssumeRolePolicyCommand'])
    expect(JSON.parse(fake.roles.get('oasis-app-role')!.trust)).toEqual(ROLE_TRUST_POLICY)
    fake.profiles.get('oasis-app-profile')!.roles = ['someone-else']
    const bad = await run([...args])
    expect(bad.code).toBe(1)
    expect(bad.out).toMatch(/oasis-app-profile already holds the role someone-else/)
  })

  it('refuses options of the other runtime', async () => {
    for (const [extra, re] of [
      [['--out', path.join(dir, 'k')], /--out and --new-access-key are for --runtime user/],
      [['--runtime', 'user', '--private-ip', '172.31.5.10'], /are for --runtime role/],
      [['--runtime', 'lambda'], /--runtime must be role or user/],
      [['--instance-id', 'i-0123456789abcdef0', '--private-ip', '172.31.5.10'], /not both/],
      [['--replace-instance-profile'], /needs --instance-id or --private-ip/],
      [['--private-ip', 'host.local'], /is not an IPv4 address/],
    ] as const) {
      const r = await run([...args, ...extra])
      expect(r.code, String(extra)).toBe(2)
      expect(r.out).toMatch(re)
    }
  })

  it('accepts the tailnet or private http origin the dashboard has before the domain exists, and nothing else over http', async () => {
    for (const ok of ['http://100.93.119.123:3240', 'http://oasis-api.tail55a040.ts.net:3240', 'http://10.0.0.5:3200', 'http://localhost:3000'])
      expect((await run(['--profile', 'oasis-setup', '--dashboard-origin', ok])).code, ok).toBe(0)
    for (const bad of ['http://oasis.example.com', 'http://8.8.8.8', 'http://100.200.1.1'])
      expect((await run(['--profile', 'oasis-setup', '--dashboard-origin', bad])).out, bad).toMatch(/https only/)
  })

  it('a later run with other dashboard origins only changes the CORS rule', async () => {
    expect((await run([...args, '--apply'])).code).toBe(0)
    fake.sent.length = 0
    const r = await run(['--profile', 'oasis-setup', '--dashboard-origin', 'https://oasis.example.com', '--dashboard-origin', 'https://app.oasisautospa.com', '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(fake.mutations().map((m) => m.command)).toEqual(['PutBucketCorsCommand'])
    expect(fake.buckets.get(PHOTOS)!.cors).toEqual(photosCors(['https://oasis.example.com', 'https://app.oasisautospa.com']).CORSRules)
  })
})

describe('documents (exact)', () => {
  it('the runtime policy: least privilege for a domain sender and for an address sender', () => {
    expect(runtimePolicy(spec(), SECRET_ARN)).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'ReadEnvironment', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: SECRET_ARN },
        { Sid: 'PhotoObjects', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'], Resource: `arn:aws:s3:::${PHOTOS}/prod/*` },
        { Sid: 'PhotoHeadMissingKey', Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${PHOTOS}` },
        { Sid: 'BackupObjects', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `arn:aws:s3:::${BACKUPS}/*` },
        { Sid: 'BackupList', Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${BACKUPS}` },
        {
          Sid: 'SendEmail',
          Effect: 'Allow',
          Action: ['ses:SendEmail', 'ses:SendRawEmail'],
          Resource: [`arn:aws:ses:us-east-1:${ACCOUNT}:identity/oasisautospa.com`, `arn:aws:ses:us-east-1:${ACCOUNT}:configuration-set/oasis-mail`],
          Condition: { StringLike: { 'ses:FromAddress': '*@oasisautospa.com' } },
        },
      ],
    })
    const addr = runtimePolicy(spec({ sender: { kind: 'address', identity: 'no-reply@oasisautospa.com', domain: 'oasisautospa.com' }, keyPrefix: '' })) as {
      Statement: Array<{ Sid: string; Resource: unknown; Condition?: unknown }>
    }
    expect(addr.Statement[1]!.Resource).toBe(`arn:aws:s3:::${PHOTOS}/*`)
    expect(addr.Statement[5]).toMatchObject({
      Resource: [`arn:aws:ses:us-east-1:${ACCOUNT}:identity/no-reply@oasisautospa.com`, `arn:aws:ses:us-east-1:${ACCOUNT}:configuration-set/oasis-mail`],
      Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@oasisautospa.com' } },
    })
  })

  it('the bucket, CORS, lifecycle and topic documents', () => {
    expect(tlsOnlyBucketPolicy(PHOTOS)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${PHOTOS}`, `arn:aws:s3:::${PHOTOS}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    })
    expect(photosCors(['https://oasis.example.com'])).toEqual({
      CORSRules: [
        { ID: 'dashboard-uploads', AllowedOrigins: ['https://oasis.example.com'], AllowedMethods: ['POST', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3000 },
      ],
    })
    expect(photosLifecycle(spec())).toEqual({
      Rules: [
        { ID: 'expire-photos', Status: 'Enabled', Filter: { Prefix: 'prod/' }, Expiration: { Days: 760 } },
        { ID: 'abort-incomplete-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
      ],
    })
    expect(backupsLifecycle(spec())).toEqual({
      Rules: [
        { ID: 'expire-backups', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 400 }, NoncurrentVersionExpiration: { NoncurrentDays: 30 } },
        { ID: 'abort-incomplete-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
      ],
    })
    expect(topicPolicy(spec())).toEqual({
      Version: '2012-10-17',
      Id: 'oasis-ses-events-policy',
      Statement: [
        {
          Sid: 'AccountOwner',
          Effect: 'Allow',
          Principal: { AWS: '*' },
          Action: ['SNS:GetTopicAttributes', 'SNS:SetTopicAttributes', 'SNS:AddPermission', 'SNS:RemovePermission', 'SNS:DeleteTopic', 'SNS:Subscribe', 'SNS:ListSubscriptionsByTopic', 'SNS:Publish'],
          Resource: TOPIC,
          Condition: { StringEquals: { 'AWS:SourceOwner': ACCOUNT } },
        },
        {
          Sid: 'SesPublishesFeedback',
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: 'SNS:Publish',
          Resource: TOPIC,
          Condition: { StringEquals: { 'AWS:SourceAccount': ACCOUNT, 'AWS:SourceArn': `arn:aws:ses:us-east-1:${ACCOUNT}:configuration-set/oasis-mail` } },
        },
      ],
    })
    expect(names({ prefix: 'oasis', account: ACCOUNT, region: 'us-east-1' })).toMatchObject({ user: 'oasis-app', policy: 'oasis-app-runtime', topic: 'oasis-ses-events' })
  })
})

describe('the temporary setup policy (docs/aws-setup.md)', () => {
  const doc = readFileSync('docs/aws-setup.md', 'utf8')
  const block = /<!-- setup-policy:start -->\s*```json\n([\s\S]*?)```\s*<!-- setup-policy:end -->/.exec(doc)
  const statements = (JSON.parse(block![1]!) as { Statement: PolicyStatement[] }).Statement
  const NOW = new Date('2026-10-08T12:00:00Z')

  it('is the policy the owner was given: every statement expires, and app names are oasis-app / oasis-app-*', () => {
    expect(statements.map((s) => s.Sid)).toEqual([
      'WhoAmI', 'Email', 'Buckets', 'ListBuckets', 'EmailEvents', 'AppUser', 'AppPolicy', 'AttachAppPolicy',
      'AppRole', 'AttachAppRolePolicy', 'PassAppRole', 'AppInstanceProfile', 'AssociateInstanceProfile', 'AppSecret', 'Firewall', 'Dns',
    ])
    for (const s of statements) expect(s.Condition?.DateLessThan?.['aws:CurrentTime'], s.Sid).toBeDefined()
    expect(statements.find((s) => s.Sid === 'AppUser')!.Resource).toBe('arn:aws:iam::*:user/oasis-app')
  })

  it('allows every call the script made in these tests (describe and change calls alike), and the evaluator is not permissive', () => {
    const ctx = { region: 'us-east-1', account: ACCOUNT }
    const seen = new Set<string>()
    const denied: string[] = []
    for (const s of allSent) {
      seen.add(s.command)
      for (const call of iamCallsOf(s.command, s.input, ctx))
        if (!allowedBy(statements, call, NOW)) denied.push(`${s.command}: ${call.action} on ${call.resource}`)
    }
    expect(denied).toEqual([])
    // the suites above exercised every kind of call the script can make
    for (const c of [
      'GetCallerIdentityCommand', 'HeadBucketCommand', 'CreateBucketCommand', 'PutPublicAccessBlockCommand', 'PutBucketEncryptionCommand', 'PutBucketCorsCommand',
      'PutBucketLifecycleConfigurationCommand', 'PutBucketPolicyCommand', 'PutBucketVersioningCommand', 'GetBucketOwnershipControlsCommand',
      'CreateEmailIdentityCommand', 'GetEmailIdentityCommand', 'CreateConfigurationSetCommand', 'CreateConfigurationSetEventDestinationCommand',
      'CreateTopicCommand', 'GetTopicAttributesCommand', 'ListSubscriptionsByTopicCommand', 'SubscribeCommand', 'CreateUserCommand', 'CreatePolicyCommand',
      'AttachUserPolicyCommand', 'CreateAccessKeyCommand', 'ListAccessKeysCommand', 'GetPolicyVersionCommand', 'ListPolicyVersionsCommand',
      'DeletePolicyVersionCommand', 'CreatePolicyVersionCommand', 'GetAccountCommand', 'PutAccountDetailsCommand',
      'DescribeSecretCommand', 'CreateSecretCommand', 'GetRoleCommand', 'CreateRoleCommand', 'UpdateAssumeRolePolicyCommand',
      'ListAttachedRolePoliciesCommand', 'AttachRolePolicyCommand', 'GetInstanceProfileCommand', 'CreateInstanceProfileCommand',
      'AddRoleToInstanceProfileCommand', 'DescribeInstancesCommand', 'DescribeIamInstanceProfileAssociationsCommand',
      'AssociateIamInstanceProfileCommand', 'ReplaceIamInstanceProfileAssociationCommand',
    ])
      expect(seen.has(c), c).toBe(true)
    // negative controls: what the policy must refuse
    expect(allowedBy(statements, { action: 's3:CreateBucket', resource: 'arn:aws:s3:::other-bucket' }, NOW)).toBe(false)
    expect(allowedBy(statements, { action: 'iam:CreateUser', resource: `arn:aws:iam::${ACCOUNT}:user/admin` }, NOW)).toBe(false)
    expect(allowedBy(statements, { action: 'iam:AttachUserPolicy', resource: `arn:aws:iam::${ACCOUNT}:user/oasis-app`, context: { 'iam:PolicyARN': 'arn:aws:iam::aws:policy/AdministratorAccess' } }, NOW)).toBe(false)
    expect(allowedBy(statements, { action: 'iam:CreatePolicy', resource: `arn:aws:iam::${ACCOUNT}:policy/oasis-app-runtime` }, new Date('2027-01-01T00:00:00Z'))).toBe(false)
    expect(allowedBy(statements, { action: 'iam:TagPolicy', resource: `arn:aws:iam::${ACCOUNT}:policy/oasis-app-runtime` }, NOW)).toBe(false)
    expect(allowedBy(statements, { action: 'iam:PassRole', resource: `arn:aws:iam::${ACCOUNT}:role/admin` }, NOW)).toBe(false)
    expect(allowedBy(statements, { action: 'iam:AttachRolePolicy', resource: `arn:aws:iam::${ACCOUNT}:role/oasis-app-role`, context: { 'iam:PolicyARN': 'arn:aws:iam::aws:policy/AdministratorAccess' } }, NOW)).toBe(false)
    expect(allowedBy(statements, { action: 'secretsmanager:GetSecretValue', resource: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:prod/db-AbCdEf` }, NOW)).toBe(false)
    expect(allowedBy(statements, { action: 'iam:CreateRole', resource: `arn:aws:iam::${ACCOUNT}:role/oasis-admin` }, NOW)).toBe(false)
  })
})
