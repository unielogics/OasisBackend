// An in-memory AWS account behind aws-sdk-client-mock: the real SDK client classes, with every command pnpm aws:provision sends
// answered from this state the way AWS answers it (error names, URL-encoded IAM documents, policy strings, pending subscriptions).
// Every command is recorded, so tests can check what was called and evaluate it against the setup policy.
import { mockClient } from 'aws-sdk-client-mock'
import * as s3 from '@aws-sdk/client-s3'
import * as ses from '@aws-sdk/client-sesv2'
import * as sns from '@aws-sdk/client-sns'
import * as iam from '@aws-sdk/client-iam'
import * as sts from '@aws-sdk/client-sts'
import * as sm from '@aws-sdk/client-secrets-manager'
import * as ec2 from '@aws-sdk/client-ec2'
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

const MUTATING = /^(Create|Put|Set|Subscribe|Attach|Update|Delete|Associate|Replace|AddRole)/

export class FakeAws {
  readonly buckets = new Map<string, Bucket>()
  readonly foreignBuckets = new Set<string>()
  readonly identities = new Map<string, { verified: boolean; tokens?: string[] }>()
  readonly configSets = new Map<string, Map<string, unknown>>()
  readonly topics = new Map<string, { attrs: Record<string, string>; subs: Array<{ Protocol: string; Endpoint: string; SubscriptionArn: string }> }>()
  readonly users = new Map<string, { attached: Set<string>; keys: Array<{ AccessKeyId: string; Status: string }> }>()
  readonly policies = new Map<string, Array<{ VersionId: string; Document: string; IsDefaultVersion: boolean; CreateDate: Date }>>()
  readonly roles = new Map<string, { trust: string; attached: Set<string> }>()
  readonly profiles = new Map<string, { roles: string[] }>()
  /** Secret name -> its value (never read by the script; recorded to prove it is created empty and never overwritten). */
  readonly secretsManager = new Map<string, { value: string; tags?: unknown; deleted?: boolean; kmsKeyId?: string }>()
  readonly instances: Array<{ InstanceId: string; PrivateIpAddress: string; State: string; Name?: string }> = []
  readonly associations: Array<{ AssociationId: string; InstanceId: string; Arn: string; State: string }> = []
  /** AssociateIamInstanceProfile fails this many times with InvalidParameterValue (IAM propagation) before it works. */
  profilePropagationFailures = 0
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

  /** Mocks the client classes; returns a factory for scripts/aws/provision.ts main(). */
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

    iamon(iam.GetRoleCommand, (i) => {
      const r = this.roles.get(String(i.RoleName))
      if (!r) throw awsError('NoSuchEntityException', 404, `The role with name ${String(i.RoleName)} cannot be found.`)
      return { Role: { RoleName: i.RoleName, Arn: `arn:aws:iam::${ACCOUNT}:role/${String(i.RoleName)}`, AssumeRolePolicyDocument: encodeURIComponent(r.trust) } }
    })
    iamon(iam.CreateRoleCommand, (i) => {
      if (this.roles.has(String(i.RoleName))) throw awsError('EntityAlreadyExistsException', 409)
      this.roles.set(String(i.RoleName), { trust: String(i.AssumeRolePolicyDocument), attached: new Set() })
      return { Role: { RoleName: i.RoleName } }
    })
    const role = (name: unknown) => {
      const r = this.roles.get(String(name))
      if (!r) throw awsError('NoSuchEntityException', 404)
      return r
    }
    iamon(iam.UpdateAssumeRolePolicyCommand, (i) => {
      role(i.RoleName).trust = String(i.PolicyDocument)
      return {}
    })
    iamon(iam.ListAttachedRolePoliciesCommand, (i) => ({ AttachedPolicies: [...role(i.RoleName).attached].map((PolicyArn) => ({ PolicyArn })) }))
    iamon(iam.AttachRolePolicyCommand, (i) => {
      policy(i.PolicyArn)
      role(i.RoleName).attached.add(String(i.PolicyArn))
      return {}
    })
    iamon(iam.GetInstanceProfileCommand, (i) => {
      const p = this.profiles.get(String(i.InstanceProfileName))
      if (!p) throw awsError('NoSuchEntityException', 404, `Instance Profile ${String(i.InstanceProfileName)} cannot be found.`)
      return {
        InstanceProfile: {
          InstanceProfileName: i.InstanceProfileName,
          Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/${String(i.InstanceProfileName)}`,
          Roles: p.roles.map((RoleName) => ({ RoleName, Arn: `arn:aws:iam::${ACCOUNT}:role/${RoleName}` })),
        },
      }
    })
    iamon(iam.CreateInstanceProfileCommand, (i) => {
      if (this.profiles.has(String(i.InstanceProfileName))) throw awsError('EntityAlreadyExistsException', 409)
      this.profiles.set(String(i.InstanceProfileName), { roles: [] })
      return {}
    })
    iamon(iam.AddRoleToInstanceProfileCommand, (i) => {
      const p = this.profiles.get(String(i.InstanceProfileName))
      if (!p) throw awsError('NoSuchEntityException', 404)
      role(i.RoleName)
      if (p.roles.length) throw awsError('LimitExceededException', 409, 'Cannot exceed quota for InstanceSessionsPerInstanceProfile: 1')
      p.roles.push(String(i.RoleName))
      return {}
    })

    const msm = mockClient(sm.SecretsManagerClient)
    msm.onAnyCommand().rejects(new Error('fake Secrets Manager: command not modelled'))
    const smon = <C extends { name: string }>(Cmd: C, fn: (i: In) => unknown) => msm.on(Cmd as never).callsFake(rec('secretsmanager', Cmd, fn) as never)
    const secretArn = (name: string) => `arn:aws:secretsmanager:${this.region}:${ACCOUNT}:secret:${name}-Ab12Cd`
    smon(sm.DescribeSecretCommand, (i) => {
      const x = this.secretsManager.get(String(i.SecretId))
      if (!x) throw awsError('ResourceNotFoundException', 400, "Secrets Manager can't find the specified secret.")
      return { ARN: secretArn(String(i.SecretId)), Name: i.SecretId, ...(x.kmsKeyId ? { KmsKeyId: x.kmsKeyId } : {}), ...(x.deleted ? { DeletedDate: new Date(0) } : {}) }
    })
    smon(sm.CreateSecretCommand, (i) => {
      const name = String(i.Name)
      if (this.secretsManager.has(name)) throw awsError('ResourceExistsException', 400)
      this.secretsManager.set(name, { value: String(i.SecretString), tags: i.Tags, ...(i.KmsKeyId ? { kmsKeyId: String(i.KmsKeyId) } : {}) })
      return { ARN: secretArn(name), Name: name }
    })

    const me2 = mockClient(ec2.EC2Client)
    me2.onAnyCommand().rejects(new Error('fake EC2: command not modelled'))
    const ec2on = <C extends { name: string }>(Cmd: C, fn: (i: In) => unknown) => me2.on(Cmd as never).callsFake(rec('ec2', Cmd, fn) as never)
    const instance = (x: (typeof this.instances)[number]) => ({
      InstanceId: x.InstanceId,
      PrivateIpAddress: x.PrivateIpAddress,
      State: { Name: x.State },
      ...(x.Name ? { Tags: [{ Key: 'Name', Value: x.Name }] } : {}),
    })
    ec2on(ec2.DescribeInstancesCommand, (i) => {
      const ids = i.InstanceIds as string[] | undefined
      const filters = (i.Filters as Array<{ Name: string; Values: string[] }> | undefined) ?? []
      if (ids) {
        const found = this.instances.filter((x) => ids.includes(x.InstanceId))
        if (!found.length) throw awsError('InvalidInstanceID.NotFound', 400, `The instance ID '${ids.join(',')}' does not exist`)
        return { Reservations: [{ Instances: found.map(instance) }] }
      }
      const ip = filters.find((f) => f.Name === 'private-ip-address')?.Values ?? []
      return { Reservations: this.instances.filter((x) => ip.includes(x.PrivateIpAddress)).map((x) => ({ Instances: [instance(x)] })) }
    })
    ec2on(ec2.DescribeIamInstanceProfileAssociationsCommand, (i) => {
      const ids = (i.Filters as Array<{ Name: string; Values: string[] }>).find((f) => f.Name === 'instance-id')?.Values ?? []
      return {
        IamInstanceProfileAssociations: this.associations
          .filter((a) => ids.includes(a.InstanceId))
          .map((a) => ({ AssociationId: a.AssociationId, InstanceId: a.InstanceId, State: a.State, IamInstanceProfile: { Arn: a.Arn, Id: 'AIPAFAKE' } })),
      }
    })
    const profileArn = (name: unknown) => {
      if (!this.profiles.has(String(name)) || this.profilePropagationFailures > 0) {
        if (this.profilePropagationFailures > 0) this.profilePropagationFailures -= 1
        throw awsError('InvalidParameterValue', 400, `Value (${String(name)}) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name`)
      }
      return `arn:aws:iam::${ACCOUNT}:instance-profile/${String(name)}`
    }
    ec2on(ec2.AssociateIamInstanceProfileCommand, (i) => {
      const id = String(i.InstanceId)
      if (this.associations.some((a) => a.InstanceId === id && a.State === 'associated'))
        throw awsError('IncorrectState', 400, `There is an existing association for instance ${id}`)
      const arn = profileArn((i.IamInstanceProfile as { Name: string }).Name)
      const AssociationId = `iip-assoc-${String(this.associations.length + 1).padStart(17, '0')}`
      this.associations.push({ AssociationId, InstanceId: id, Arn: arn, State: 'associated' })
      return { IamInstanceProfileAssociation: { AssociationId, InstanceId: id, State: 'associating' } }
    })
    ec2on(ec2.ReplaceIamInstanceProfileAssociationCommand, (i) => {
      const a = this.associations.find((x) => x.AssociationId === i.AssociationId)
      if (!a) throw awsError('InvalidAssociationID.NotFound', 400)
      a.Arn = profileArn((i.IamInstanceProfile as { Name: string }).Name)
      return { IamInstanceProfileAssociation: { AssociationId: a.AssociationId, InstanceId: a.InstanceId, State: 'associating' } }
    })

    const mt = mockClient(sts.STSClient)
    mt.onAnyCommand().rejects(new Error('fake STS: command not modelled'))
    mt.on(sts.GetCallerIdentityCommand).callsFake(
      rec('sts', sts.GetCallerIdentityCommand, () => ({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/oasis-setup-temp`, UserId: 'AIDAFAKE' })) as never,
    )

    this.mocks = [m3, me, mn, mi, mt, msm, me2]
    return (cfg) => ({
      s3: new s3.S3Client({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      ses: new ses.SESv2Client({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      sns: new sns.SNSClient({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      iam: new iam.IAMClient({ region: 'us-east-1', credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      sts: new sts.STSClient({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      sm: new sm.SecretsManagerClient({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
      ec2: new ec2.EC2Client({ region: cfg.region, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test' } }),
    })
  }

  restore(): void {
    for (const m of this.mocks) m.restore()
    this.mocks = []
  }
}
