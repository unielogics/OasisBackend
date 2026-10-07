// pnpm verify:aws  -  walks the one-time AWS setup of docs/integrations/ses.md and docs/integrations/s3.md against the real account:
// SES identity, DKIM and sandbox status, the configuration set, a test email; the S3 bucket, Block Public Access, CORS, lifecycle and
// a presigned-POST round trip (put, head, get, delete under a verify/ prefix). Missing IAM permissions are listed one by one with
// the action name, because an AccessDenied from S3 does not say which action was refused.
//
// SAFE BY DEFAULT: without --send only configuration is READ. --send --to <email> adds the two writes: one test email, and the
// S3 round trip (the object lives for a second and is deleted again).
import { randomUUID } from 'node:crypto'
import {
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2'
import {
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetPublicAccessBlockCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { envSchema } from '../../src/config/env.js'
import { SesProvider } from '../../src/integrations/email/ses-provider.js'
import { S3Storage } from '../../src/integrations/storage/s3-provider.js'
import { normalizePrefix } from '../../src/integrations/storage/keys.js'
import { StorageError } from '../../src/integrations/storage/types.js'
import {
  MissingConfig,
  Report,
  UsageError,
  cli,
  maskEmail,
  type ItemDef,
  type RunContext,
  type RunResult,
} from './lib.js'
import { AwsSim } from './sim-aws.js'

const SES_DOC = 'docs/integrations/ses.md, One-time AWS setup'
const S3_DOC = 'docs/integrations/s3.md, One-time AWS setup'

export const AWS_ITEMS: readonly ItemDef[] = [
  {
    id: 'AWS-01',
    title: 'SES: the sending identity is verified and DKIM is SUCCESS',
    source: `${SES_DOC}, step 1`,
  },
  {
    id: 'AWS-02',
    title: 'SES: the account is out of the sandbox and sending is enabled',
    source: `${SES_DOC}, step 2`,
  },
  {
    id: 'AWS-03',
    title: 'SES: the configuration set exists and publishes bounce, complaint and delivery events',
    source: `${SES_DOC}, step 3`,
  },
  {
    id: 'AWS-04',
    title: 'SES: the feedback topic is subscribed to /hooks/ses (or the SQS queue)',
    source: `${SES_DOC}, step 4`,
  },
  {
    id: 'AWS-05',
    title: 'SES: the IAM policy lets the app send as the configured sender',
    source: `${SES_DOC}, step 5`,
  },
  {
    id: 'AWS-06',
    title: 'SES: one test email accepted for --to (through the app SesProvider)',
    source: `${SES_DOC} and the live smoke test in milestone M6`,
  },
  {
    id: 'AWS-S1',
    title: 'S3: the bucket exists, Block Public Access is on, and the policy requires TLS',
    source: `${S3_DOC}, step 1`,
  },
  { id: 'AWS-S2', title: 'S3: CORS lets the dashboard origin POST', source: `${S3_DOC}, step 2` },
  {
    id: 'AWS-S3',
    title: 'S3: the IAM policy allows the presigned POST, head, get and delete (round trip under verify/)',
    source: `${S3_DOC}, step 3`,
  },
  {
    id: 'AWS-S4',
    title: 'S3: lifecycle rules (backstop expiry, abort incomplete uploads)',
    source: `${S3_DOC}, step 4`,
  },
  {
    id: 'AWS-S5',
    title: 'S3: the app settings agree with the bucket (STORAGE_PROVIDER, region, prefix, encryption)',
    source: `${S3_DOC}, step 5`,
  },
  {
    id: 'AWS-G1',
    title: 'IAM: no permission the app needs is missing',
    source: 'docs/integrations/ses.md step 5 and docs/integrations/s3.md step 3',
  },
]

export const AWS_OPTIONS = {
  flags: ['send', 'instance-profile'],
  options: ['to', 'only', 'sim-port', 'dashboard-origin'],
} as const

interface Gap {
  action: string
  resource: string
  detail: string
}

const DENIED = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'Forbidden',
  'UnauthorizedOperation',
  'AuthorizationError',
])
const BAD_CREDENTIALS = new Set([
  'UnrecognizedClientException',
  'InvalidAccessKeyId',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidSignatureException',
  'AuthFailure',
  'CredentialsProviderError',
])

/** The key, secret or session token was refused: a different problem from a missing permission. */
function isBadCredentials(e: unknown): boolean {
  const x = e as { name?: string; cause?: unknown } | undefined
  if (!x) return false
  if (BAD_CREDENTIALS.has(x.name ?? '')) return true
  return x.cause ? isBadCredentials(x.cause) : false
}

function isDenied(e: unknown): boolean {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number }; cause?: unknown } | undefined
  if (!x || isBadCredentials(e)) return false
  if (DENIED.has(x.name ?? '') || x.$metadata?.httpStatusCode === 403) return true
  return x.cause ? isDenied(x.cause) : false
}

function nameOf(e: unknown): string {
  const x = e as { name?: string; cause?: unknown }
  return x.name && x.name !== 'Error' ? x.name : x.cause ? nameOf(x.cause) : (x.name ?? 'Error')
}

const short = (e: unknown): string => `${nameOf(e)}: ${((e as Error).message ?? String(e)).slice(0, 220)}`

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export async function runAws(ctx: RunContext): Promise<RunResult> {
  try {
    return await runInner(ctx)
  } catch (e) {
    if (e instanceof MissingConfig) return { missing: e }
    throw e
  }
}

async function runInner(ctx: RunContext): Promise<RunResult> {
  const { args, env } = ctx
  const sim = args.flag('sim')
  const only = args.value('only')
  if (only !== undefined && only !== 'ses' && only !== 's3') throw new UsageError('--only must be ses or s3')
  const wantSes = only !== 's3'
  const wantS3 = only !== 'ses'
  const send = args.flag('send')
  const toRaw = args.value('to')
  if (send && wantSes && !toRaw)
    throw new UsageError(
      '--send needs --to <email>: no email is sent without an explicit recipient (success@simulator.amazonses.com is safe in the sandbox)',
    )
  if (toRaw && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toRaw))
    throw new UsageError(`--to "${toRaw}" is not an email address`)

  let awsSim: AwsSim | undefined
  let region: string
  let from: string | undefined
  let bucket: string | undefined
  let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined
  let endpoint: string | undefined
  const dashboardOrigin = args.value('dashboard-origin') ?? env.PUBLIC_DASHBOARD_URL
  if (sim) {
    awsSim = new AwsSim({
      bucket: 'oasis-sim',
      verifiedIdentities: ['oasis.example', 'tester@example.com'],
      cors: {
        origins: [dashboardOrigin ? new URL(dashboardOrigin).origin : 'http://localhost:3000'],
        methods: ['POST', 'GET', 'HEAD'],
      },
    })
    endpoint = await awsSim.start(args.number('sim-port') ?? 4592)
    region = 'us-east-1'
    from = 'no-reply@oasis.example'
    bucket = 'oasis-sim'
    credentials = { accessKeyId: awsSim.opts.accessKeyId, secretAccessKey: 'simulator-secret' }
  } else {
    region = env.AWS_REGION?.trim() || 'us-east-1'
    from = env.SES_FROM_ADDRESS?.trim()
    bucket = env.S3_BUCKET?.trim()
    const need: Array<{ name: string; why: string }> = []
    const haveKeys = !!env.AWS_ACCESS_KEY_ID && !!env.AWS_SECRET_ACCESS_KEY
    if (!haveKeys && !env.AWS_PROFILE && !args.flag('instance-profile'))
      need.push({
        name: 'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY',
        why: 'an IAM user key for this check (or AWS_PROFILE=<profile>, or pass --instance-profile on an EC2 host whose role is the one to test). Nothing probes instance metadata unless you pass --instance-profile.',
      })
    if (wantSes && !from)
      need.push({
        name: 'SES_FROM_ADDRESS',
        why: 'the sender the app uses, on the verified domain (e.g. no-reply@oasisautospa.example)',
      })
    if (wantS3 && !bucket)
      need.push({ name: 'S3_BUCKET', why: 'the photo bucket (see docs/integrations/s3.md, bucket creation)' })
    if (need.length)
      throw new MissingConfig('aws', need, [
        'Optional: AWS_REGION (default us-east-1), S3_KEY_PREFIX (prod/), S3_SSE, S3_KMS_KEY_ID, SES_CONFIGURATION_SET, SES_SNS_TOPIC_ARNS, PUBLIC_DASHBOARD_URL.',
        'Console steps and the IAM policies as JSON: docs/live-verification.md, "AWS".',
      ])
    if (haveKeys)
      credentials = {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      }
    endpoint = env.AWS_ENDPOINT_URL
  }

  const report = new Report(
    'aws',
    'AWS live verification',
    AWS_ITEMS,
    {
      mode: sim ? 'sim' : 'live',
      target: `region ${region}${bucket ? `, bucket ${bucket}` : ''}${from ? `, sender ${maskEmail(from)}` : ''}`,
    },
    ctx.now,
    ctx.log,
  )
  report.secret(credentials?.secretAccessKey)
  report.secret(credentials?.sessionToken)
  report.secret(toRaw)
  const r = report
  const gaps: Gap[] = []
  const gap = (action: string, resource: string, detail: string): void => {
    if (!gaps.some((g) => g.action === action)) gaps.push({ action, resource, detail })
  }
  const diag = new Set<string>()
  const failWith = (id: string, e: unknown): void => {
    if (isBadCredentials(e))
      r.fail(
        id,
        short(e),
        'AWS rejected the credentials: check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN (temporary keys expire) and that the key belongs to the account that owns the bucket and the SES identity.',
      )
    else r.fail(id, short(e))
  }

  const common = { region, ...(credentials ? { credentials } : {}), ...(endpoint ? { endpoint } : {}) }
  const sesClient = new SESv2Client(common)
  const s3Client = new S3Client({
    ...common,
    ...(sim || endpoint || env.S3_FORCE_PATH_STYLE === 'true' ? { forcePathStyle: true } : {}),
    ...(env.S3_ENDPOINT && !sim ? { endpoint: env.S3_ENDPOINT } : {}),
  })

  try {
    if (wantSes) await sesChecks()
    else
      for (const id of ['AWS-01', 'AWS-02', 'AWS-03', 'AWS-04', 'AWS-05', 'AWS-06']) r.skip(id, '--only s3')
    if (wantS3) await s3Checks()
    else for (const id of ['AWS-S1', 'AWS-S2', 'AWS-S3', 'AWS-S4', 'AWS-S5']) r.skip(id, '--only ses')

    if (!send) {
      r.skip(
        'AWS-G1',
        'the permissions the app needs (ses:SendEmail, s3:PutObject, GetObject, DeleteObject, ListBucket) are only exercised by the writes: pass --send --to <email>',
      )
    } else if (gaps.length === 0) {
      r.pass('AWS-G1', 'every action the app uses was accepted')
    } else {
      r.fail(
        'AWS-G1',
        `${gaps.length} missing: ${gaps.map((g) => g.action).join(', ')}`,
        `Add to the app role's policy: ${gaps.map((g) => `${g.action} on ${g.resource}`).join('; ')} (policies as JSON in docs/integrations/ses.md step 5 and docs/integrations/s3.md step 3).`,
        gaps.map((g) => `${g.action}  ${g.resource}  ${g.detail}`),
      )
    }
    if (diag.size)
      r.note(
        `checks marked SKIP because this identity may not read the configuration (the app itself does not need these): ${[...diag].join(', ')}. Run the verification with an administrator or a read-only auditor key to see them.`,
      )
  } finally {
    sesClient.destroy()
    s3Client.destroy()
    await awsSim?.stop()
  }
  return { report }

  // ---- SES ------------------------------------------------------------------------------------------------------------------
  async function sesChecks(): Promise<void> {
    const sender = from!
    const domain = sender.split('@')[1] ?? ''
    const readDenied = (id: string, action: string, resource: string): void => {
      diag.add(action)
      r.skip(id, `this identity may not call ${action} on ${resource}; the app does not need it`)
    }

    // 1. identity + DKIM
    let identityId = domain
    let identity = await sesClient
      .send(new GetEmailIdentityCommand({ EmailIdentity: domain }))
      .catch((e: unknown) => e)
    if (identity instanceof Error && nameOf(identity) === 'NotFoundException') {
      identityId = sender
      identity = await sesClient
        .send(new GetEmailIdentityCommand({ EmailIdentity: sender }))
        .catch((e: unknown) => e)
    }
    if (identity instanceof Error) {
      if (isDenied(identity)) readDenied('AWS-01', 'ses:GetEmailIdentity', `identity/${domain}`)
      else if (nameOf(identity) === 'NotFoundException')
        r.fail(
          'AWS-01',
          `neither the domain ${domain} nor the address ${maskEmail(sender)} is a verified SES identity in ${region}`,
          `Create the identity (aws sesv2 create-email-identity --email-identity ${domain} --region ${region}) and add the three DKIM CNAMEs it shows.`,
        )
      else failWith('AWS-01', identity)
    } else {
      const id = identity as {
        IdentityType?: string
        VerifiedForSendingStatus?: boolean
        DkimAttributes?: { Status?: string; SigningEnabled?: boolean }
        MailFromAttributes?: { MailFromDomainStatus?: string }
      }
      const dkim = id.DkimAttributes?.Status
      const detail = `${identityId} (${id.IdentityType}): verified for sending ${id.VerifiedForSendingStatus}${dkim ? `, DKIM ${dkim}` : ''}${id.MailFromAttributes?.MailFromDomainStatus ? `, MAIL FROM ${id.MailFromAttributes.MailFromDomainStatus}` : ''}`
      if (id.VerifiedForSendingStatus && (!dkim || dkim === 'SUCCESS')) r.pass('AWS-01', detail)
      else
        r.fail(
          'AWS-01',
          detail,
          'Add the DKIM CNAME records SES lists for the identity (DNS can take a few hours) and wait for DKIM SUCCESS.',
        )
    }

    // 2. account / sandbox
    const account = await sesClient.send(new GetAccountCommand({})).catch((e: unknown) => e)
    if (account instanceof Error) {
      if (isDenied(account)) readDenied('AWS-02', 'ses:GetAccount', '*')
      else failWith('AWS-02', account)
    } else {
      const a = account as {
        ProductionAccessEnabled?: boolean
        SendingEnabled?: boolean
        EnforcementStatus?: string
        SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number }
      }
      const q = a.SendQuota
      const detail = `${a.ProductionAccessEnabled ? 'production access' : 'SANDBOX'}, sending ${a.SendingEnabled ? 'enabled' : 'PAUSED'}, enforcement ${a.EnforcementStatus ?? 'unknown'}, quota ${q?.SentLast24Hours ?? '?'} of ${q?.Max24HourSend ?? '?'} per 24 h at ${q?.MaxSendRate ?? '?'}/s`
      if (!a.SendingEnabled)
        r.fail(
          'AWS-02',
          detail,
          'Sending is paused for the account; open the SES console, Account dashboard.',
        )
      else if (!a.ProductionAccessEnabled)
        r.fail(
          'AWS-02',
          detail,
          `Only verified recipients and the mailbox simulator can receive mail. Request production access: aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://<site> --additional-contact-email-addresses <ops@...> --contact-language EN --region ${region}`,
        )
      else r.pass('AWS-02', detail)
    }

    // 3. configuration set
    const cs = env.SES_CONFIGURATION_SET?.trim() || (sim ? 'oasis-sim' : undefined)
    if (!cs) {
      r.skip(
        'AWS-03',
        'SES_CONFIGURATION_SET is not set: bounces and complaints are not published (needed before sending real volume)',
      )
    } else {
      const set = await sesClient
        .send(new GetConfigurationSetCommand({ ConfigurationSetName: cs }))
        .catch((e: unknown) => e)
      if (set instanceof Error) {
        if (isDenied(set)) readDenied('AWS-03', 'ses:GetConfigurationSet', `configuration-set/${cs}`)
        else if (nameOf(set) === 'NotFoundException')
          r.fail(
            'AWS-03',
            `configuration set ${cs} does not exist in ${region}`,
            `aws sesv2 create-configuration-set --configuration-set-name ${cs} --region ${region}, then the SNS event destination of docs/integrations/ses.md step 3.`,
          )
        else failWith('AWS-03', set)
      } else {
        const dest = await sesClient
          .send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: cs }))
          .catch((e: unknown) => e)
        if (dest instanceof Error) {
          if (isDenied(dest))
            readDenied('AWS-03', 'ses:GetConfigurationSetEventDestinations', `configuration-set/${cs}`)
          else failWith('AWS-03', dest)
        } else {
          const events = new Set(
            (
              dest as { EventDestinations?: Array<{ Enabled?: boolean; MatchingEventTypes?: string[] }> }
            ).EventDestinations?.filter((d) => d.Enabled).flatMap((d) => d.MatchingEventTypes ?? []),
          )
          const missing = ['BOUNCE', 'COMPLAINT'].filter((x) => !events.has(x))
          if (missing.length === 0) r.pass('AWS-03', `${cs}: events ${[...events].join(', ')}`)
          else
            r.fail(
              'AWS-03',
              `${cs} exists but does not publish ${missing.join(' and ')}`,
              'Create the event destination (docs/integrations/ses.md step 3) with BOUNCE, COMPLAINT and DELIVERY.',
            )
        }
      }
    }

    r.skip(
      'AWS-04',
      'needs sns:ListSubscriptionsByTopic / sqs:GetQueueAttributes, which this check does not use; run aws sns list-subscriptions-by-topic --topic-arn $SES_SNS_TOPIC_ARNS and expect a Confirmed https subscription to /hooks/ses',
    )

    // 5 + 6: the send exercises ses:SendEmail
    if (!send) {
      r.skip('AWS-05', 'sends one email: pass --send --to <email>')
      r.skip('AWS-06', 'sends one email: pass --send --to <email>')
      return
    }
    const to = toRaw!
    r.note(`sending one email to ${maskEmail(to)} as ${maskEmail(sender)}`)
    const provider = new SesProvider({
      client: sesClient,
      from: sender,
      ...(env.SES_FROM_NAME ? { fromName: env.SES_FROM_NAME } : {}),
      ...(cs ? { configurationSet: cs } : {}),
    })
    try {
      const out = await provider.send({
        to,
        template: 'device_alert',
        vars: {
          deviceLabel: 'Live verification',
          status: 'working',
          occurredLabel: ctx.now().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          detail: 'This is a test message from pnpm verify:aws. Nothing is wrong.',
          shopName: 'Oasis Auto Spa',
        },
      })
      r.pass('AWS-05', 'SES accepted SendEmail for this sender')
      r.pass(
        'AWS-06',
        `accepted by SES, MessageId ${out.id.slice(0, 18)}...; check the inbox${/simulator\.amazonses\.com$/.test(to) ? ' (the mailbox simulator has none)' : ''}`,
      )
    } catch (e) {
      const cause = (e as { cause?: unknown }).cause ?? e
      if (isDenied(cause)) {
        gap(
          'ses:SendEmail',
          `arn:aws:ses:${region}:<account>:identity/${domain} (and the configuration set ${cs ?? '-'})`,
          short(cause),
        )
        r.fail(
          'AWS-05',
          `AccessDenied: ${short(cause)}`,
          `Allow ses:SendEmail on the identity ${domain}${cs ? ` and configuration-set/${cs}` : ''} with ses:FromAddress ${sender} (docs/integrations/ses.md step 5).`,
        )
        r.skip('AWS-06', 'the send was denied')
      } else {
        r.pass('AWS-05', 'no IAM refusal')
        const msg = short(cause)
        r.fail(
          'AWS-06',
          msg,
          /not verified/i.test(msg)
            ? 'In the sandbox the recipient must be a verified identity, or use success@simulator.amazonses.com; the sender must be on a verified identity (AWS-01, AWS-02).'
            : 'See the SES error above; EmailError.code PROVIDER_REJECTED is not retryable.',
        )
      }
    }
  }

  // ---- S3 -----------------------------------------------------------------------------------------------------------------
  async function s3Checks(): Promise<void> {
    const Bucket = bucket!
    // What the running app sees is the environment after loadEnv(): variables src/config/env.ts does not declare are dropped, so
    // the round trip below uses only the settings the app will really have.
    const declared = new Set(
      Object.keys(
        (envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema.shape,
      ),
    )
    const prefix = declared.has('S3_KEY_PREFIX') || sim ? normalizePrefix(env.S3_KEY_PREFIX ?? '') : ''
    const readDenied = (id: string, action: string): void => {
      diag.add(action)
      r.skip(id, `this identity may not call ${action} on ${Bucket}; the app does not need it`)
    }

    // 1. bucket, public access block, TLS policy
    const headBucket = await s3Client.send(new HeadBucketCommand({ Bucket })).catch((e: unknown) => e)
    if (headBucket instanceof Error) {
      if (isDenied(headBucket)) {
        diag.add('s3:ListBucket')
        r.skip('AWS-S1', 'this identity may not call HeadBucket (s3:ListBucket)')
      } else if (nameOf(headBucket) === 'NotFound' || nameOf(headBucket) === 'NoSuchBucket') {
        r.fail(
          'AWS-S1',
          `bucket ${Bucket} does not exist (or is in another region than ${region})`,
          `aws s3api create-bucket --bucket ${Bucket} --region ${region} (docs/integrations/s3.md step 1).`,
        )
      } else failWith('AWS-S1', headBucket)
    } else {
      const pab = await s3Client.send(new GetPublicAccessBlockCommand({ Bucket })).catch((e: unknown) => e)
      const pol = await s3Client.send(new GetBucketPolicyCommand({ Bucket })).catch((e: unknown) => e)
      const notes: string[] = []
      let bad = false
      if (pab instanceof Error) {
        if (isDenied(pab)) {
          diag.add('s3:GetBucketPublicAccessBlock')
          notes.push('Block Public Access unreadable')
        } else {
          bad = true
          notes.push(
            nameOf(pab) === 'NoSuchPublicAccessBlockConfiguration'
              ? 'Block Public Access is NOT configured'
              : short(pab),
          )
        }
      } else {
        const c =
          (pab as { PublicAccessBlockConfiguration?: Record<string, boolean | undefined> })
            .PublicAccessBlockConfiguration ?? {}
        const off = [
          'BlockPublicAcls',
          'IgnorePublicAcls',
          'BlockPublicPolicy',
          'RestrictPublicBuckets',
        ].filter((k) => c[k] !== true)
        if (off.length) bad = true
        notes.push(
          off.length ? `Block Public Access off for ${off.join(', ')}` : 'Block Public Access fully on',
        )
      }
      if (pol instanceof Error) {
        if (isDenied(pol)) diag.add('s3:GetBucketPolicy')
        else if (nameOf(pol) === 'NoSuchBucketPolicy') {
          bad = true
          notes.push('no bucket policy (add the TLS-only Deny)')
        } else notes.push(short(pol))
      } else {
        const text = (pol as { Policy?: string }).Policy ?? ''
        if (/aws:SecureTransport/.test(text)) notes.push('TLS-only policy present')
        else {
          bad = true
          notes.push('bucket policy lacks the aws:SecureTransport deny')
        }
      }
      if (bad)
        r.fail(
          'AWS-S1',
          `${Bucket}: ${notes.join('; ')}`,
          'aws s3api put-public-access-block ... and the DenyInsecureTransport policy of docs/integrations/s3.md step 1.',
        )
      else r.pass('AWS-S1', `${Bucket}: ${notes.join('; ')}`)
    }

    // 2. CORS
    const cors = await s3Client.send(new GetBucketCorsCommand({ Bucket })).catch((e: unknown) => e)
    if (cors instanceof Error) {
      if (isDenied(cors)) readDenied('AWS-S2', 's3:GetBucketCORS')
      else if (nameOf(cors) === 'NoSuchCORSConfiguration')
        r.fail(
          'AWS-S2',
          `no CORS configuration on ${Bucket}: the browser cannot POST photos`,
          'aws s3api put-bucket-cors --bucket ... --cors-configuration file://cors.json (docs/integrations/s3.md step 2).',
        )
      else failWith('AWS-S2', cors)
    } else {
      const rules =
        (cors as { CORSRules?: Array<{ AllowedOrigins?: string[]; AllowedMethods?: string[] }> }).CORSRules ??
        []
      const origin = dashboardOrigin ? new URL(dashboardOrigin).origin : undefined
      const post = rules.filter((x) => x.AllowedMethods?.includes('POST'))
      const originOk = origin
        ? post.some((x) => x.AllowedOrigins?.some((o) => o === '*' || o === origin))
        : post.length > 0
      const wildcard = post.some((x) => x.AllowedOrigins?.includes('*'))
      const detail = `POST allowed for ${post.flatMap((x) => x.AllowedOrigins ?? []).join(', ') || 'nobody'}${origin ? `; dashboard origin ${origin} ${originOk ? 'matches' : 'does NOT match'}` : '; PUBLIC_DASHBOARD_URL is not set, so the origin was not compared'}${wildcard ? ' (wildcard origin: restrict it)' : ''}`
      if (originOk) r.pass('AWS-S2', detail)
      else
        r.fail(
          'AWS-S2',
          detail,
          'Set AllowedOrigins to exactly the dashboard origin with AllowedMethods POST, GET, HEAD (docs/integrations/s3.md step 2).',
        )
    }

    // 3. round trip
    if (!send) {
      r.skip('AWS-S3', 'writes and deletes one tiny object under verify/: pass --send --to <email>')
    } else {
      const sse = !(declared.has('S3_SSE') || sim)
        ? undefined
        : env.S3_SSE === 'AES256'
          ? ({ mode: 'AES256' } as const)
          : env.S3_SSE === 'aws:kms'
            ? ({ mode: 'aws:kms', ...(env.S3_KMS_KEY_ID ? { kmsKeyId: env.S3_KMS_KEY_ID } : {}) } as const)
            : undefined
      const storage = new S3Storage({
        client: s3Client,
        bucket: Bucket,
        keyPrefix: `${prefix}verify/`,
        ...(sse ? { sse } : {}),
      })
      const run = randomUUID().slice(0, 8)
      const key = `loc/verify/appt/${run}/arrival/${run}.png`
      const full = `${prefix}verify/${key}`
      const steps: string[] = []
      let uploaded = false
      try {
        const slot = await storage.createUpload({
          key,
          contentType: 'image/png',
          maxBytes: 1_000_000,
          ttlSec: 60,
        })
        const form = new FormData()
        for (const [k, v] of Object.entries(slot.fields)) form.append(k, v)
        form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'verify.png')
        const post = await fetch(slot.url, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(30_000),
        })
        if (post.status !== 204 && post.status !== 201 && post.status !== 200) {
          const text = (await post.text()).slice(0, 300)
          if (post.status === 403 && /AccessDenied/.test(text) && !/Policy/.test(text))
            gap(
              's3:PutObject',
              `arn:aws:s3:::${Bucket}/${prefix}verify/*`,
              `presigned POST answered 403 ${text.replace(/\s+/g, ' ').slice(0, 120)}`,
            )
          throw new Error(`presigned POST answered HTTP ${post.status}: ${text.replace(/\s+/g, ' ')}`)
        }
        uploaded = true
        steps.push('presigned POST accepted')
        const head = await storage.head(key)
        if (!head) throw new Error('head() found nothing right after the upload')
        if (head.bytes !== PNG_1X1.length || head.contentType !== 'image/png')
          throw new Error(
            `head() says ${head.bytes} bytes ${head.contentType}, expected ${PNG_1X1.length} image/png`,
          )
        steps.push(`head ${head.bytes} bytes ${head.contentType}`)
        const url = await storage.getDownloadUrl(key, 60)
        const got = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (got.status === 403)
          gap('s3:GetObject', `arn:aws:s3:::${Bucket}/${prefix}verify/*`, 'presigned GET answered 403')
        if (!got.ok) throw new Error(`presigned GET answered HTTP ${got.status}`)
        if (!Buffer.from(await got.arrayBuffer()).equals(PNG_1X1))
          throw new Error('the downloaded bytes differ from the uploaded bytes')
        steps.push('presigned GET returned identical bytes')
        await storage.delete(key)
        uploaded = false
        steps.push('delete accepted')
        const after = await storage.head(key)
        if (after !== null) throw new Error('the object is still there after delete')
        steps.push('head after delete is 404 (so s3:ListBucket is allowed)')
        r.pass('AWS-S3', steps.join('; '))
      } catch (e) {
        const cause = e instanceof StorageError ? (e.cause ?? e) : e
        const text = short(cause)
        const stage = steps.length
        if (isDenied(cause)) {
          // the SDK call that failed tells which action was refused
          const action =
            stage === 1
              ? 's3:GetObject'
              : stage === 3
                ? 's3:DeleteObject'
                : stage >= 4
                  ? 's3:ListBucket'
                  : 's3:PutObject'
          gap(
            action,
            action === 's3:ListBucket'
              ? `arn:aws:s3:::${Bucket}`
              : `arn:aws:s3:::${Bucket}/${prefix}verify/*`,
            text,
          )
        }
        r.fail(
          'AWS-S3',
          `after: ${steps.join('; ') || 'nothing'}; then: ${text}`,
          'Allow s3:PutObject, s3:GetObject and s3:DeleteObject on the prefix and s3:ListBucket on the bucket (docs/integrations/s3.md step 3). Without s3:ListBucket a missing key reads as 403, not 404.',
          steps,
        )
      } finally {
        if (uploaded) {
          await s3Client
            .send(new DeleteObjectCommand({ Bucket, Key: full }))
            .then(() => r.note(`cleaned up ${full} after a failed round trip`))
            .catch(() => r.note(`COULD NOT delete the test object ${full}: remove it by hand`))
        }
      }
    }

    // 4. lifecycle
    const life = await s3Client
      .send(new GetBucketLifecycleConfigurationCommand({ Bucket }))
      .catch((e: unknown) => e)
    if (life instanceof Error) {
      if (isDenied(life)) readDenied('AWS-S4', 's3:GetLifecycleConfiguration')
      else if (nameOf(life) === 'NoSuchLifecycleConfiguration')
        r.skip(
          'AWS-S4',
          'no lifecycle rules (optional backstop; the retention job deletes photos). Add the abort-incomplete-uploads rule at least (docs/integrations/s3.md step 4)',
        )
      else failWith('AWS-S4', life)
    } else {
      const rules =
        (
          life as {
            Rules?: Array<{
              ID?: string
              Status?: string
              Expiration?: { Days?: number }
              AbortIncompleteMultipartUpload?: unknown
            }>
          }
        ).Rules ?? []
      const expire = rules.find((x) => x.Status === 'Enabled' && x.Expiration?.Days)
      const abort = rules.find((x) => x.Status === 'Enabled' && x.AbortIncompleteMultipartUpload)
      const detail = `${rules.length} rule(s); expiry ${expire ? `${expire.Expiration?.Days} days` : 'none'}; abort incomplete uploads ${abort ? 'yes' : 'no'}`
      if (expire && abort) r.pass('AWS-S4', detail)
      else
        r.fail(
          'AWS-S4',
          detail,
          'Add the two rules of docs/integrations/s3.md step 4 (expiry slightly longer than the 24-month retention, abort incomplete uploads after 1 day).',
        )
    }

    // 5. settings vs bucket
    const enc = await s3Client.send(new GetBucketEncryptionCommand({ Bucket })).catch((e: unknown) => e)
    const problems: string[] = []
    if (!sim && env.STORAGE_PROVIDER && env.STORAGE_PROVIDER !== 's3')
      problems.push(`STORAGE_PROVIDER is ${env.STORAGE_PROVIDER}, not s3`)
    const ignored = ['S3_KEY_PREFIX', 'S3_SSE', 'S3_KMS_KEY_ID', 'S3_ENDPOINT', 'S3_FORCE_PATH_STYLE'].filter(
      (k) => !!env[k] && !declared.has(k) && !sim,
    )
    if (ignored.length)
      problems.push(
        `${ignored.join(', ')} ${ignored.length > 1 ? 'are' : 'is'} set but src/config/env.ts does not declare ${ignored.length > 1 ? 'them' : 'it'}, so the app ignores ${ignored.length > 1 ? 'them' : 'it'} (no prefix, no encryption header); this check used the value, the app will not`,
      )
    if (env.S3_BUCKET && env.S3_BUCKET !== Bucket) problems.push('S3_BUCKET differs')
    let encNote = 'default encryption unreadable'
    if (enc instanceof Error) {
      if (isDenied(enc)) diag.add('s3:GetEncryptionConfiguration')
      else if (nameOf(enc) === 'ServerSideEncryptionConfigurationNotFoundError') {
        encNote = 'no default encryption'
        problems.push('the bucket has no default encryption')
      } else encNote = short(enc)
    } else {
      encNote = `default encryption ${(enc as { ServerSideEncryptionConfiguration?: { Rules?: Array<{ ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }> } }).ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? 'unknown'}`
    }
    if (problems.length)
      r.fail(
        'AWS-S5',
        `${problems.join('; ')}; ${encNote}`,
        'Set STORAGE_PROVIDER=s3, S3_BUCKET and AWS_REGION in /etc/oasis/common.env (docs/integrations/s3.md step 5); prefix and encryption settings only count once src/config/env.ts declares them.',
      )
    else r.pass('AWS-S5', `region ${region}, prefix "${prefix || '(none)'}", ${encNote}`)
  }
}

export const HELP = `pnpm verify:aws [options]

Checks SES and S3 against your AWS account and writes docs/live-verification/<date>-aws.md and .json. Configuration is only READ unless
--send is given. Exit code 0 = no FAIL, 1 = at least one FAIL, 2 = configuration missing or bad command line.

Environment (or --sim): AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY (or AWS_PROFILE, or --instance-profile) SES_FROM_ADDRESS S3_BUCKET
Optional: AWS_REGION S3_KEY_PREFIX S3_SSE S3_KMS_KEY_ID SES_CONFIGURATION_SET SES_FROM_NAME PUBLIC_DASHBOARD_URL S3_ENDPOINT S3_FORCE_PATH_STYLE

  --sim                 run against the built-in AWS simulator (port 4592, --sim-port)
  --send --to EMAIL     the two writes: one test email to EMAIL, and the S3 presigned-POST round trip under <prefix>verify/
  --only ses|s3         check only one service
  --instance-profile    use the IAM role of this EC2 host (the only way instance metadata is contacted)
  --dashboard-origin U  origin the CORS rule must allow (default PUBLIC_DASHBOARD_URL)
  --out-dir DIR         where reports go (default docs/live-verification)
  --json                also print the JSON summary
`

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log: (l: string) => void = console.log,
): Promise<number> {
  return cli('verify:aws', HELP, argv, runAws, AWS_OPTIONS, env, log)
}

if (process.argv[1] && process.argv[1].endsWith('aws.ts')) {
  main(process.argv.slice(2)).then((c) => process.exit(c))
}
