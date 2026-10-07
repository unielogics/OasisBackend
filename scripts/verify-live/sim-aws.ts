// An in-process AWS stand-in for `pnpm verify:aws --sim` and its tests: the SESv2 REST/JSON calls and the path-style S3 calls the
// verification uses, answered over real HTTP so the real AWS SDK clients (and the app's SesProvider and S3Storage) run unchanged.
//
//   pnpm sim:aws [--port 4592]
//
// What it does model: the SES sandbox (only verified recipients, only a verified sender), identities with DKIM status, the account
// quota, a configuration set with an SNS event destination, S3 objects (PUT/HEAD/GET/DELETE and the presigned POST policy: expiry,
// content-length-range, eq/starts-with on every field, key and bucket), bucket CORS / public access block / lifecycle / encryption /
// policy, the HEAD-missing-key 404-versus-403 rule that depends on s3:ListBucket, and per-action AccessDenied.
// What it does not: SigV4 signature maths (it checks that the access key id is the configured one), SNS/SQS, regions.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { parseMultipart } from '../../src/integrations/storage/multipart.js'

export interface AwsSimOptions {
  accessKeyId?: string
  region?: string
  account?: string
  bucket?: string
  /** Identities SES treats as verified; a domain also verifies every address on it. */
  verifiedIdentities?: string[]
  /** Sandbox: only verified recipients and the mailbox simulator may receive mail. */
  sandbox?: boolean
  sendingEnabled?: boolean
  dkimStatus?: 'SUCCESS' | 'PENDING' | 'FAILED'
  configurationSet?: string | null
  /** IAM actions that answer AccessDenied, e.g. 'ses:SendEmail', 's3:DeleteObject', 's3:ListBucket'. */
  deny?: string[]
  cors?: { origins: string[]; methods: string[] } | null
  publicAccessBlock?: {
    BlockPublicAcls: boolean
    IgnorePublicAcls: boolean
    BlockPublicPolicy: boolean
    RestrictPublicBuckets: boolean
  } | null
  lifecycle?: boolean
  encryption?: 'AES256' | 'aws:kms' | null
  tlsOnlyPolicy?: boolean
}

interface StoredObject {
  body: Buffer
  contentType: string
}

export class AwsSim {
  readonly opts: Required<Omit<AwsSimOptions, 'configurationSet'>> & { configurationSet: string | null }
  readonly objects = new Map<string, StoredObject>()
  readonly sentEmails: Array<{
    from: string
    to: string[]
    subject: string
    messageId: string
    configurationSet?: string
  }> = []
  readonly requests: string[] = []
  private server?: Server

  constructor(opts: AwsSimOptions = {}) {
    this.opts = {
      accessKeyId: 'AKIASIMULATOR000000',
      region: 'us-east-1',
      account: '123456789012',
      bucket: 'oasis-sim',
      verifiedIdentities: ['oasis.example'],
      sandbox: false,
      sendingEnabled: true,
      dkimStatus: 'SUCCESS',
      configurationSet: 'oasis-sim',
      deny: [],
      cors: { origins: ['https://dashboard.oasis.example'], methods: ['POST', 'GET', 'HEAD'] },
      publicAccessBlock: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
      lifecycle: true,
      encryption: 'AES256',
      tlsOnlyPolicy: true,
      ...opts,
    }
  }

  get url(): string {
    const a = this.server?.address() as AddressInfo | null | undefined
    if (!a) throw new Error('AWS simulator is not listening')
    return `http://127.0.0.1:${a.port}`
  }

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((e: Error) =>
        this.json(res, 500, { message: e.message }, 'InternalFailure'),
      )
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(port, '127.0.0.1', resolve)
    })
    return this.url
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  private isVerified(address: string): boolean {
    const a = address.toLowerCase()
    const domain = a.split('@')[1]
    return this.opts.verifiedIdentities.some((v) => v.toLowerCase() === a || v.toLowerCase() === domain)
  }

  private denied(action: string): boolean {
    return this.opts.deny.includes(action)
  }

  // ---- responses ---------------------------------------------------------------------------------------------------------

  private json(res: ServerResponse, status: number, body: unknown, errorType?: string): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      ...(errorType ? { 'x-amzn-errortype': errorType } : {}),
      'x-amzn-requestid': randomUUID(),
    })
    res.end(JSON.stringify(body))
  }

  private xml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, {
      'content-type': 'application/xml',
      'x-amz-request-id': randomUUID().slice(0, 16).toUpperCase(),
      ...headers,
    })
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`)
  }

  private s3Error(res: ServerResponse, status: number, code: string, message: string, head = false): void {
    if (head) {
      res.writeHead(status, { 'x-amz-request-id': randomUUID().slice(0, 16).toUpperCase() })
      res.end()
      return
    }
    this.xml(res, status, `<Error><Code>${code}</Code><Message>${message}</Message></Error>`)
  }

  private accessDenied(
    res: ServerResponse,
    kind: 'ses' | 's3',
    action: string,
    resource: string,
    head = false,
  ): void {
    const msg = `User: arn:aws:iam::${this.opts.account}:user/oasis-sim is not authorized to perform: ${action} on resource: ${resource}`
    if (kind === 'ses') this.json(res, 403, { message: msg }, 'AccessDeniedException')
    else this.s3Error(res, 403, 'AccessDenied', 'Access Denied', head)
  }

  // ---- routing -------------------------------------------------------------------------------------------------------------

  private authorised(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization ?? ''
    const q = url.searchParams.get('X-Amz-Credential') ?? ''
    return (
      header.includes(`Credential=${this.opts.accessKeyId}/`) || q.startsWith(`${this.opts.accessKeyId}/`)
    )
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim')
    const method = req.method ?? 'GET'
    this.requests.push(`${method} ${url.pathname}${url.search ? '?' + url.search.slice(1, 40) : ''}`)
    const body = await this.readBody(req)
    const isPresignedPost =
      method === 'POST' && (req.headers['content-type'] ?? '').startsWith('multipart/form-data')
    if (!isPresignedPost && !this.authorised(req, url)) {
      return url.pathname.startsWith('/v2/email')
        ? this.json(
            res,
            403,
            { message: 'The security token included in the request is invalid.' },
            'UnrecognizedClientException',
          )
        : this.s3Error(
            res,
            403,
            'InvalidAccessKeyId',
            'The AWS Access Key Id you provided does not exist in our records.',
            method === 'HEAD',
          )
    }
    if (url.pathname.startsWith('/v2/email')) return this.ses(method, url, body, res)
    return this.s3(method, url, body, req, res, isPresignedPost)
  }

  // ---- SES v2 ----------------------------------------------------------------------------------------------------------------

  private ses(method: string, url: URL, body: Buffer, res: ServerResponse): void {
    const arn = (kind: string, name: string): string =>
      `arn:aws:ses:${this.opts.region}:${this.opts.account}:${kind}/${name}`
    const path = url.pathname
    let m: RegExpMatchArray | null
    if (method === 'GET' && path === '/v2/email/account') {
      if (this.denied('ses:GetAccount')) return this.accessDenied(res, 'ses', 'ses:GetAccount', '*')
      return this.json(res, 200, {
        DedicatedIpAutoWarmupEnabled: false,
        EnforcementStatus: 'HEALTHY',
        ProductionAccessEnabled: !this.opts.sandbox,
        SendQuota: this.opts.sandbox
          ? { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: this.sentEmails.length }
          : { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: this.sentEmails.length },
        SendingEnabled: this.opts.sendingEnabled,
      })
    }
    if (method === 'GET' && (m = path.match(/^\/v2\/email\/identities\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!)
      if (this.denied('ses:GetEmailIdentity'))
        return this.accessDenied(res, 'ses', 'ses:GetEmailIdentity', arn('identity', id))
      const known = this.opts.verifiedIdentities.find((v) => v.toLowerCase() === id.toLowerCase())
      if (!known)
        return this.json(res, 404, { message: `Email identity <${id}> does not exist.` }, 'NotFoundException')
      const domain = !id.includes('@')
      return this.json(res, 200, {
        IdentityType: domain ? 'DOMAIN' : 'EMAIL_ADDRESS',
        VerifiedForSendingStatus: this.opts.dkimStatus === 'SUCCESS' || !domain,
        FeedbackForwardingStatus: true,
        DkimAttributes: domain
          ? {
              SigningEnabled: true,
              Status: this.opts.dkimStatus,
              Tokens: ['aaaa', 'bbbb', 'cccc'],
              SigningAttributesOrigin: 'AWS_SES',
            }
          : undefined,
        MailFromAttributes: domain
          ? {
              MailFromDomain: `mail.${id}`,
              MailFromDomainStatus: 'SUCCESS',
              BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
            }
          : undefined,
      })
    }
    if (
      method === 'GET' &&
      (m = path.match(/^\/v2\/email\/configuration-sets\/([^/]+)\/event-destinations$/))
    ) {
      if (this.denied('ses:GetConfigurationSetEventDestinations'))
        return this.accessDenied(
          res,
          'ses',
          'ses:GetConfigurationSetEventDestinations',
          arn('configuration-set', m[1]!),
        )
      return this.json(res, 200, {
        EventDestinations: [
          {
            Name: 'sns-feedback',
            Enabled: true,
            MatchingEventTypes: ['BOUNCE', 'COMPLAINT', 'DELIVERY'],
            SnsDestination: {
              TopicArn: `arn:aws:sns:${this.opts.region}:${this.opts.account}:oasis-ses-feedback`,
            },
          },
        ],
      })
    }
    if (method === 'GET' && (m = path.match(/^\/v2\/email\/configuration-sets\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]!)
      if (this.denied('ses:GetConfigurationSet'))
        return this.accessDenied(res, 'ses', 'ses:GetConfigurationSet', arn('configuration-set', name))
      if (name !== this.opts.configurationSet)
        return this.json(
          res,
          404,
          { message: `Configuration set <${name}> does not exist.` },
          'NotFoundException',
        )
      return this.json(res, 200, { ConfigurationSetName: name, SendingOptions: { SendingEnabled: true } })
    }
    if (method === 'POST' && path === '/v2/email/outbound-emails') {
      const req = JSON.parse(body.toString('utf8') || '{}') as {
        FromEmailAddress?: string
        Destination?: { ToAddresses?: string[] }
        Content?: { Simple?: { Subject?: { Data?: string } } }
        ConfigurationSetName?: string
      }
      const from = (/<([^>]+)>/.exec(req.FromEmailAddress ?? '')?.[1] ?? req.FromEmailAddress ?? '').trim()
      const to = req.Destination?.ToAddresses ?? []
      if (this.denied('ses:SendEmail'))
        return this.accessDenied(res, 'ses', 'ses:SendEmail', arn('identity', from.split('@')[1] ?? from))
      if (!this.opts.sendingEnabled)
        return this.json(res, 400, { message: 'Account sending is paused.' }, 'SendingPausedException')
      if (!this.isVerified(from))
        return this.json(
          res,
          400,
          {
            message: `Email address is not verified. The following identities failed the check in region ${this.opts.region.toUpperCase()}: ${from}`,
          },
          'MessageRejected',
        )
      if (req.ConfigurationSetName && req.ConfigurationSetName !== this.opts.configurationSet)
        return this.json(
          res,
          404,
          { message: `Configuration set <${req.ConfigurationSetName}> does not exist.` },
          'NotFoundException',
        )
      if (this.opts.sandbox) {
        const bad = to.filter(
          (t) => !this.isVerified(t) && !t.toLowerCase().endsWith('@simulator.amazonses.com'),
        )
        if (bad.length)
          return this.json(
            res,
            400,
            {
              message: `Email address is not verified. The following identities failed the check in region ${this.opts.region.toUpperCase()}: ${bad.join(', ')}`,
            },
            'MessageRejected',
          )
      }
      const messageId = `0100${randomUUID().replace(/-/g, '')}-sim`
      this.sentEmails.push({
        from,
        to,
        subject: req.Content?.Simple?.Subject?.Data ?? '',
        messageId,
        ...(req.ConfigurationSetName ? { configurationSet: req.ConfigurationSetName } : {}),
      })
      return this.json(res, 200, { MessageId: messageId })
    }
    this.json(res, 404, { message: `no such SES resource ${path}` }, 'NotFoundException')
  }

  // ---- S3 (path style: /bucket/key) -----------------------------------------------------------------------------------------

  private s3(
    method: string,
    url: URL,
    body: Buffer,
    req: IncomingMessage,
    res: ServerResponse,
    presignedPost: boolean,
  ): void {
    const parts = url.pathname.split('/').filter(Boolean)
    const bucket = decodeURIComponent(parts[0] ?? '')
    const key = parts.slice(1).map(decodeURIComponent).join('/')
    const head = method === 'HEAD'
    const barn = `arn:aws:s3:::${bucket}`
    if (bucket !== this.opts.bucket)
      return this.s3Error(res, head ? 404 : 404, 'NoSuchBucket', 'The specified bucket does not exist', head)

    if (!key) {
      if (presignedPost) return this.postObject(body, req, res)
      const sub = [...url.searchParams.keys()][0]
      if (method === 'HEAD' && !sub) {
        if (this.denied('s3:ListBucket')) return this.accessDenied(res, 's3', 's3:ListBucket', barn, true)
        return void res.writeHead(200, { 'x-amz-bucket-region': this.opts.region }).end()
      }
      if (method === 'GET') return this.bucketConfig(sub ?? '', res, barn)
      return this.s3Error(
        res,
        405,
        'MethodNotAllowed',
        'The specified method is not allowed against this resource.',
      )
    }

    if (method === 'PUT') {
      if (this.denied('s3:PutObject')) return this.accessDenied(res, 's3', 's3:PutObject', `${barn}/${key}`)
      this.objects.set(key, {
        body,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
      })
      return void res.writeHead(200, { etag: '"sim"' }).end()
    }
    const obj = this.objects.get(key)
    if (method === 'HEAD' || method === 'GET') {
      if (this.denied('s3:GetObject'))
        return this.accessDenied(res, 's3', 's3:GetObject', `${barn}/${key}`, head)
      if (!obj) {
        // S3 answers 404 for a missing key only when the caller may list the bucket; otherwise 403.
        if (this.denied('s3:ListBucket')) return this.accessDenied(res, 's3', 's3:ListBucket', barn, head)
        return this.s3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.', head)
      }
      res.writeHead(200, {
        'content-type': obj.contentType,
        'content-length': String(obj.body.length),
        etag: '"sim"',
      })
      return void res.end(head ? undefined : obj.body)
    }
    if (method === 'DELETE') {
      if (this.denied('s3:DeleteObject'))
        return this.accessDenied(res, 's3', 's3:DeleteObject', `${barn}/${key}`)
      this.objects.delete(key)
      return void res.writeHead(204).end()
    }
    this.s3Error(res, 405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.')
  }

  private bucketConfig(sub: string, res: ServerResponse, barn: string): void {
    const o = this.opts
    const need = (action: string): boolean => {
      if (!this.denied(action)) return true
      this.accessDenied(res, 's3', action, barn)
      return false
    }
    if (sub === 'cors') {
      if (!need('s3:GetBucketCORS')) return
      if (!o.cors)
        return this.s3Error(res, 404, 'NoSuchCORSConfiguration', 'The CORS configuration does not exist')
      return this.xml(
        res,
        200,
        `<CORSConfiguration><CORSRule>${o.cors.origins.map((x) => `<AllowedOrigin>${x}</AllowedOrigin>`).join('')}${o.cors.methods.map((x) => `<AllowedMethod>${x}</AllowedMethod>`).join('')}<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3000</MaxAgeSeconds></CORSRule></CORSConfiguration>`,
      )
    }
    if (sub === 'publicAccessBlock') {
      if (!need('s3:GetBucketPublicAccessBlock')) return
      if (!o.publicAccessBlock)
        return this.s3Error(
          res,
          404,
          'NoSuchPublicAccessBlockConfiguration',
          'The public access block configuration was not found',
        )
      return this.xml(
        res,
        200,
        `<PublicAccessBlockConfiguration>${Object.entries(o.publicAccessBlock)
          .map(([k, v]) => `<${k}>${v}</${k}>`)
          .join('')}</PublicAccessBlockConfiguration>`,
      )
    }
    if (sub === 'lifecycle') {
      if (!need('s3:GetLifecycleConfiguration')) return
      if (!o.lifecycle)
        return this.s3Error(
          res,
          404,
          'NoSuchLifecycleConfiguration',
          'The lifecycle configuration does not exist',
        )
      return this.xml(
        res,
        200,
        '<LifecycleConfiguration><Rule><ID>expire-photos-after-24-months</ID><Status>Enabled</Status><Filter><Prefix>prod/loc/</Prefix></Filter><Expiration><Days>760</Days></Expiration></Rule><Rule><ID>abort-incomplete-uploads</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>',
      )
    }
    if (sub === 'encryption') {
      if (!need('s3:GetEncryptionConfiguration')) return
      if (!o.encryption)
        return this.s3Error(
          res,
          404,
          'ServerSideEncryptionConfigurationNotFoundError',
          'The server side encryption configuration was not found',
        )
      return this.xml(
        res,
        200,
        `<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>${o.encryption}</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`,
      )
    }
    if (sub === 'policy') {
      if (!need('s3:GetBucketPolicy')) return
      if (!o.tlsOnlyPolicy)
        return this.s3Error(res, 404, 'NoSuchBucketPolicy', 'The bucket policy does not exist')
      res.writeHead(200, { 'content-type': 'application/json' })
      return void res.end(
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'DenyInsecureTransport',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [barn, `${barn}/*`],
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            },
          ],
        }),
      )
    }
    this.s3Error(res, 404, 'NotImplemented', `the simulator does not serve ?${sub}`)
  }

  /** Browser-style upload: multipart/form-data with the signed policy; evaluated the way S3 does. */
  private postObject(body: Buffer, req: IncomingMessage, res: ServerResponse): void {
    if (this.denied('s3:PutObject'))
      return this.accessDenied(res, 's3', 's3:PutObject', `arn:aws:s3:::${this.opts.bucket}/*`)
    const form = parseMultipart(body, String(req.headers['content-type'] ?? ''))
    const f = form.fields
    if (!(f['X-Amz-Credential'] ?? '').startsWith(`${this.opts.accessKeyId}/`))
      return this.s3Error(
        res,
        403,
        'InvalidAccessKeyId',
        'The AWS Access Key Id you provided does not exist in our records.',
      )
    let policy: { expiration: string; conditions: Array<unknown> }
    try {
      policy = JSON.parse(Buffer.from(f.Policy ?? '', 'base64').toString('utf8')) as typeof policy
    } catch {
      return this.s3Error(res, 400, 'InvalidPolicyDocument', 'Invalid Policy: not JSON')
    }
    if (Date.parse(policy.expiration) < Date.now())
      return this.s3Error(res, 403, 'AccessDenied', 'Invalid according to Policy: Policy expired.')
    const file = form.file
    if (!file)
      return this.s3Error(res, 400, 'InvalidArgument', 'POST requires exactly one file upload per request.')
    const covered = new Set<string>([
      'policy',
      'x-amz-signature',
      'file',
      'x-amz-algorithm',
      'x-amz-credential',
      'x-amz-date',
      'x-amz-security-token',
    ])
    const lc = Object.fromEntries(
      Object.entries({ ...f, bucket: this.opts.bucket }).map(([k, v]) => [k.toLowerCase(), v]),
    )
    for (const c of policy.conditions) {
      if (Array.isArray(c) && c[0] === 'content-length-range') {
        if (file.data.length < Number(c[1]) || file.data.length > Number(c[2]))
          return this.s3Error(
            res,
            400,
            'EntityTooLarge',
            'Your proposed upload exceeds the maximum allowed size',
          )
        continue
      }
      const [op, field, value] = Array.isArray(c)
        ? (c as [string, string, string])
        : (['eq', `$${Object.keys(c as object)[0]}`, Object.values(c as object)[0]] as [
            string,
            string,
            string,
          ])
      const name = field.replace(/^\$/, '').toLowerCase()
      covered.add(name)
      const actual = lc[name] ?? ''
      const ok = op === 'eq' ? actual === value : op === 'starts-with' ? actual.startsWith(value) : false
      if (!ok)
        return this.s3Error(
          res,
          403,
          'AccessDenied',
          `Invalid according to Policy: Policy Condition failed: ["${op}", "${field}", "${value}"]`,
        )
    }
    for (const name of Object.keys(lc))
      if (!covered.has(name))
        return this.s3Error(
          res,
          403,
          'AccessDenied',
          `Invalid according to Policy: Extra input fields: ${name}`,
        )
    this.objects.set(f.key ?? '', { body: file.data, contentType: f['Content-Type'] ?? file.contentType })
    res.writeHead(204, { etag: '"sim"' }).end()
  }
}

if (process.argv[1]?.endsWith('sim-aws.ts')) {
  const i = process.argv.indexOf('--port')
  const sim = new AwsSim()
  const url = await sim.start(i > 0 ? Number(process.argv[i + 1]) : 4592)
  console.log(
    `AWS simulator listening on ${url}  (SESv2 /v2/email/*, S3 path style /${sim.opts.bucket}/<key>)`,
  )
  console.log(
    `  access key ${sim.opts.accessKeyId}, bucket ${sim.opts.bucket}, verified identities ${sim.opts.verifiedIdentities.join(', ')}`,
  )
  console.log(
    `  pnpm verify:aws --sim runs the whole checklist against its own copy; this process is for poking at by hand`,
  )
  const stop = (): void => void sim.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
