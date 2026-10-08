// An in-memory AWS account behind aws-sdk-client-mock: the real SDK client classes, with every command pnpm aws:provision sends
// answered from this state the way AWS answers it (error names, URL-encoded IAM documents, policy strings, pending subscriptions).
// Every command is recorded, so tests can check what was called and evaluate it against the setup policy.
import { mockClient } from 'aws-sdk-client-mock'
import * as s3 from '@aws-sdk/client-s3'
import * as ses from '@aws-sdk/client-sesv2'
import * as sns from '@aws-sdk/client-sns'
import * as iam from '@aws-sdk/client-iam'
import * as sts from '@aws-sdk/client-sts'
import type { Clients } from '../../../scripts/aws/lib/provision.js'

export const ACCOUNT = '123456789012'

const awsError = (name: string, status: number, message = name): Error =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status }, $fault: 'client' })

type In = Record<string, unknown>

export interface Bucket {
  pab?: unknown
  ownership?: unknown
  enc?: unknown
  cors?: unknown[]
  life?: unknown[]
  policy?: string
  versioning?: string
}

export interface Sent {
  service: string
  command: string
  input: In
}

const MUTATING = /^(Create|Put|Set|Subscribe|Attach|Update|Delete)/

export class FakeAws {
  readonly buckets = new Map<string, Bucket>()
  readonly foreignBuckets = new Set<string>()
  readonly identities = new Map<string, { verified: boolean; tokens?: string[] }>()
  readonly configSets = new Map<string, Map<string, unknown>>()
  readonly topics = new Map<string, { attrs: Record<string, string>; subs: Array<{ Protocol: string; Endpoint: string; SubscriptionArn: string }> }>()
  readonly users = new Map<string, { attached: Set<string>; keys: Array<{ AccessKeyId: string; Status: string }> }>()
  readonly policies = new Map<string, Array<{ VersionId: string; Document: string; IsDefaultVersion: boolean; CreateDate: Date }>>()
  production = false
  review: string | undefined
  readonly sent: Sent[] = []
  readonly secrets: string[] = []
  private keySeq = 0
  private mocks: Array<{ restore(): void }> = []

  constructor(readonly region = 'us-east-1') {}

  mutations(): Sent[] {
    return this.sent.filter((s) => MUTATING.test(s.command))
  }

  /** Mocks the five client classes; returns a factory for scripts/aws/provision.ts main(). */
  install(): (cfg: { region: string; profile?: string }) => Clients {
    const rec = (service: string, Cmd: { name: string }, fn: (i: In) => unknown) => async (i: In) => {
      this.sent.push({ service, command: Cmd.name, input: i })
      return fn(i)
    }
    const m3 = mockClient(s3.S3Client)
    m3.onAnyCommand().rejects(new Error('fake S3: command not modelled'))
    const bucket = (i: In): Bucket => {
      const name = String(i.Bucket)
      if (this.foreignBuckets.has(name)) throw awsError('Forbidden', 403)
      const b = this.buckets.get(name)
      if (!b) throw awsError('NoSuchBucket', 404)
      return b
    }
    const s3on = <C extends { name: string }>(Cmd: C, fn: (i: In) => unknown) =>
      m3.on(Cmd as never).callsFake(rec('s3', Cmd, fn) as never)
    s3on(s3.HeadBucketCommand, (i) => {
      const name = String(i.Bucket)
      if (this.foreignBuckets.has(name)) throw awsError('Forbidden', 403)
      if (!this.buckets.has(name)) throw awsError('NotFound', 404)
      return {}
    })
    s3on(s3.CreateBucketCommand, (i) => {
      if (this.buckets.has(String(i.Bucket))) throw awsError('BucketAlreadyOwnedByYou', 409)
      this.buckets.set(String(i.Bucket), {
        ownership: i.ObjectOwnership ? { Rules: [{ ObjectOwnership: i.ObjectOwnership }] } : undefined,
        // new buckets get SSE-S3 by default
        enc: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false }] },
      })
      return { Location: `/${String(i.Bucket)}` }
    })
    const getset = (
      get: { name: string },
      put: { name: string },
      field: keyof Bucket,
      missing: string,
      out: (v: unknown) => unknown,
      inp: (i: In) => unknown,
    ) => {
      s3on(get, (i) => {
        const v = bucket(i)[field]
        if (v === undefined) throw awsError(missing, 404)
        return out(v)
      })
      s3on(put, (i) => {
        ;(bucket(i) as Record<string, unknown>)[field] = inp(i)
        return {}
      })
    }
    getset(s3.GetPublicAccessBlockCommand, s3.PutPublicAccessBlockCommand, 'pab', 'NoSuchPublicAccessBlockConfiguration', (v) => ({ PublicAccessBlockConfiguration: v }), (i) => i.PublicAccessBlockConfiguration)
    getset(s3.GetBucketOwnershipControlsCommand, s3.PutBucketOwnershipControlsCommand, 'ownership', 'OwnershipControlsNotFoundError', (v) => ({ OwnershipControls: v }), (i) => i.OwnershipControls)
    getset(s3.GetBucketEncryptionCommand, s3.PutBucketEncryptionCommand, 'enc', 'ServerSideEncryptionConfigurationNotFoundError', (v) => ({ ServerSideEncryptionConfiguration: v }), (i) => i.ServerSideEncryptionConfiguration)
    getset(s3.GetBucketCorsCommand, s3.PutBucketCorsCommand, 'cors', 'NoSuchCORSConfiguration', (v) => ({ CORSRules: v }), (i) => (i.CORSConfiguration as { CORSRules: unknown[] }).CORSRules)
    getset(s3.GetBucketLifecycleConfigurationCommand, s3.PutBucketLifecycleConfigurationCommand, 'life', 'NoSuchLifecycleConfiguration', (v) => ({ Rules: v }), (i) => (i.LifecycleConfiguration as { Rules: unknown[] }).Rules)
    getset(s3.GetBucketPolicyCommand, s3.PutBucketPolicyCommand, 'policy', 'NoSuchBucketPolicy', (v) => ({ Policy: v }), (i) => i.Policy)
    s3on(s3.GetBucketVersioningCommand, (i) => (bucket(i).versioning ? { Status: bucket(i).versioning } : {}))
    s3on(s3.PutBucketVersioningCommand, (i) => {
      bucket(i).versioning = (i.VersioningConfiguration as { Status: string }).Status
      return {}
    })

    const me = mockClient(ses.SESv2Client)
    me.onAnyCommand().rejects(new Error('fake SES: command not modelled'))
    const seson = <C extends { name: string }>(Cmd: C, fn: (i: In) => unknown) => me.on(Cmd as never).callsFake(rec('ses', Cmd, fn) as never)
    seson(ses.GetEmailIdentityCommand, (i) => {
      const id = this.identities.get(String(i.EmailIdentity))
      if (!id) throw awsError('NotFoundException', 404)
      const domain = !String(i.EmailIdentity).includes('@')
      return {
        IdentityType: domain ? 'DOMAIN' : 'EMAIL_ADDRESS',
        VerifiedForSendingStatus: id.verified,
        ...(domain ? { DkimAttributes: { Status: id.verified ? 'SUCCESS' : 'PENDING', Tokens: id.tokens } } : {}),
      }
    })
    seson(ses.CreateEmailIdentityCommand, (i) => {
      const name = String(i.EmailIdentity)
      if (this.identities.has(name)) throw awsError('AlreadyExistsException', 400)
      const tokens = name.includes('@') ? undefined : ['tok1abc', 'tok2def', 'tok3ghi']
      this.identities.set(name, { verified: false, ...(tokens ? { tokens } : {}) })
      return { IdentityType: tokens ? 'DOMAIN' : 'EMAIL_ADDRESS', VerifiedForSendingStatus: false, ...(tokens ? { DkimAttributes: { Status: 'PENDING', Tokens: tokens } } : {}) }
    })
    seson(ses.GetConfigurationSetCommand, (i) => {
      if (!this.configSets.has(String(i.ConfigurationSetName))) throw awsError('NotFoundException', 404)
      return { ConfigurationSetName: i.ConfigurationSetName }
    })
    seson(ses.CreateConfigurationSetCommand, (i) => {
      if (this.configSets.has(String(i.ConfigurationSetName))) throw awsError('AlreadyExistsException', 400)
      this.configSets.set(String(i.ConfigurationSetName), new Map())
      return {}
    })
    const dests = (i: In) => {
      const d = this.configSets.get(String(i.ConfigurationSetName))
      if (!d) throw awsError('NotFoundException', 404)
      return d
    }
    seson(ses.GetConfigurationSetEventDestinationsCommand, (i) => ({
      EventDestinations: [...dests(i).entries()].map(([Name, d]) => ({ Name, ...(d as object) })),
    }))
    seson(ses.CreateConfigurationSetEventDestinationCommand, (i) => {
      if (!this.topics.has(String((i.EventDestination as { SnsDestination?: { TopicArn?: string } }).SnsDestination?.TopicArn)))
        throw awsError('BadRequestException', 400, 'the SNS topic does not exist')
      dests(i).set(String(i.EventDestinationName), i.EventDestination)
      return {}
    })
    seson(ses.UpdateConfigurationSetEventDestinationCommand, (i) => {
      dests(i).set(String(i.EventDestinationName), i.EventDestination)
      return {}
    })
    seson(ses.GetAccountCommand, () => ({
      ProductionAccessEnabled: this.production,
      SendingEnabled: true,
      ...(this.review ? { Details: { ReviewDetails: { Status: this.review } } } : {}),
    }))
    seson(ses.PutAccountDetailsCommand, () => {
      this.review = 'PENDING'
      return {}
    })

    const mn = mockClient(sns.SNSClient)
    mn.onAnyCommand().rejects(new Error('fake SNS: command not modelled'))
    const snson = <C extends { name: string }>(Cmd: C, fn: (i: In) => unknown) => mn.on(Cmd as never).callsFake(rec('sns', Cmd, fn) as never)
    const topic = (arn: unknown) => {
      const t = this.topics.get(String(arn))
      if (!t) throw awsError('NotFoundException', 404, 'Topic does not exist')
      return t
    }
    snson(sns.GetTopicAttributesCommand, (i) => ({ Attributes: { TopicArn: String(i.TopicArn), ...topic(i.TopicArn).attrs } }))
    snson(sns.CreateTopicCommand, (i) => {
      const arn = `arn:aws:sns:${this.region}:${ACCOUNT}:${String(i.Name)}`
      if (!this.topics.has(arn)) this.topics.set(arn, { attrs: { ...((i.Attributes as Record<string, string>) ?? {}) }, subs: [] })
      return { TopicArn: arn }
    })
    snson(sns.SetTopicAttributesCommand, (i) => {
      topic(i.TopicArn).attrs[String(i.AttributeName)] = String(i.AttributeValue)
      return {}
    })
    snson(sns.ListSubscriptionsByTopicCommand, (i) => ({ Subscriptions: topic(i.TopicArn).subs.map((s) => ({ ...s, TopicArn: i.TopicArn })) }))
    snson(sns.SubscribeCommand, (i) => {
      const t = topic(i.TopicArn)
      if (!t.subs.some((s) => s.Endpoint === i.Endpoint))
        t.subs.push({ Protocol: String(i.Protocol), Endpoint: String(i.Endpoint), SubscriptionArn: 'PendingConfirmation' })
      return { SubscriptionArn: 'pending confirmation' }
    })

    const mi = mockClient(iam.IAMClient)
    mi.onAnyCommand().rejects(new Error('fake IAM: command not modelled'))
    const iamon = <C extends { name: string }>(Cmd: C, fn: (i: In) => unknown) => mi.on(Cmd as never).callsFake(rec('iam', Cmd, fn) as never)
    const user = (name: unknown) => {
      const u = this.users.get(String(name))
      if (!u) throw awsError('NoSuchEntityException', 404, `The user with name ${String(name)} cannot be found.`)
      return u
    }
    const policy = (arn: unknown) => {
      const p = this.policies.get(String(arn))
      if (!p) throw awsError('NoSuchEntityException', 404, `Policy ${String(arn)} does not exist`)
      return p
    }
    iamon(iam.GetUserCommand, (i) => (user(i.UserName), { User: { UserName: i.UserName, Arn: `arn:aws:iam::${ACCOUNT}:user/${String(i.UserName)}` } }))
    iamon(iam.CreateUserCommand, (i) => {
      if (this.users.has(String(i.UserName))) throw awsError('EntityAlreadyExistsException', 409)
      this.users.set(String(i.UserName), { attached: new Set(), keys: [] })
      return { User: { UserName: i.UserName } }
    })
    iamon(iam.ListAttachedUserPoliciesCommand, (i) => ({ AttachedPolicies: [...user(i.UserName).attached].map((PolicyArn) => ({ PolicyArn })) }))
    iamon(iam.AttachUserPolicyCommand, (i) => {
      policy(i.PolicyArn)
      user(i.UserName).attached.add(String(i.PolicyArn))
      return {}
    })
    iamon(iam.ListAccessKeysCommand, (i) => ({ AccessKeyMetadata: user(i.UserName).keys.map((k) => ({ ...k, UserName: i.UserName })) }))
    iamon(iam.CreateAccessKeyCommand, (i) => {
      const u = user(i.UserName)
      if (u.keys.length >= 2) throw awsError('LimitExceededException', 409)
      this.keySeq += 1
      const AccessKeyId = `AKIAFAKEKEY${String(this.keySeq).padStart(9, '0')}`
      const SecretAccessKey = `fake/secret/${this.keySeq}/abcdefghijklmnopqrstuvwxyz0123`
      this.secrets.push(SecretAccessKey, AccessKeyId)
      u.keys.push({ AccessKeyId, Status: 'Active' })
      return { AccessKey: { UserName: i.UserName, AccessKeyId, SecretAccessKey, Status: 'Active' } }
    })
    iamon(iam.GetPolicyCommand, (i) => {
      const p = policy(i.PolicyArn)
      return { Policy: { Arn: i.PolicyArn, DefaultVersionId: p.find((v) => v.IsDefaultVersion)!.VersionId } }
    })
    iamon(iam.CreatePolicyCommand, (i) => {
      const arn = `arn:aws:iam::${ACCOUNT}:policy/${String(i.PolicyName)}`
      if (this.policies.has(arn)) throw awsError('EntityAlreadyExistsException', 409)
      this.policies.set(arn, [{ VersionId: 'v1', Document: encodeURIComponent(String(i.PolicyDocument)), IsDefaultVersion: true, CreateDate: new Date(0) }])
      return { Policy: { Arn: arn, DefaultVersionId: 'v1' } }
    })
    iamon(iam.GetPolicyVersionCommand, (i) => {
      const v = policy(i.PolicyArn).find((x) => x.VersionId === i.VersionId)
      if (!v) throw awsError('NoSuchEntityException', 404)
      return { PolicyVersion: v }
    })
    iamon(iam.ListPolicyVersionsCommand, (i) => ({ Versions: policy(i.PolicyArn).map(({ VersionId, IsDefaultVersion, CreateDate }) => ({ VersionId, IsDefaultVersion, CreateDate })) }))
    iamon(iam.CreatePolicyVersionCommand, (i) => {
      const p = policy(i.PolicyArn)
      if (p.length >= 5) throw awsError('LimitExceededException', 409, 'A managed policy can have up to 5 versions')
      const n = Math.max(...p.map((v) => Number(v.VersionId.slice(1)))) + 1
      if (i.SetAsDefault) for (const v of p) v.IsDefaultVersion = false
      p.push({ VersionId: `v${n}`, Document: encodeURIComponent(String(i.PolicyDocument)), IsDefaultVersion: !!i.SetAsDefault, CreateDate: new Date(n * 1000) })
      return { PolicyVersion: { VersionId: `v${n}` } }
    })
    iamon(iam.DeletePolicyVersionCommand, (i) => {
      const p = policy(i.PolicyArn)
      const idx = p.findIndex((v) => v.VersionId === i.VersionId)
      if (idx < 0 || p[idx]!.IsDefaultVersion) throw awsError('DeleteConflictException', 409)
      p.splice(idx, 1)
      return {}
    })

    const mt = mockClient(sts.STSClient)
    mt.onAnyCommand().rejects(new Error('fake STS: command not modelled'))
    mt.on(sts.GetCallerIdentityCommand).callsFake(
      rec('sts', sts.GetCallerIdentityCommand, () => ({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/oasis-setup-temp`, UserId: 'AIDAFAKE' })) as never,
    )

    this.mocks = [m3, me, mn, mi, mt]
    return (cfg) => ({
      s3: new s3.S3Client({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      ses: new ses.SESv2Client({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      sns: new sns.SNSClient({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      iam: new iam.IAMClient({ region: 'us-east-1', credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      sts: new sts.STSClient({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
    })
  }

  restore(): void {
    for (const m of this.mocks) m.restore()
    this.mocks = []
  }
}
