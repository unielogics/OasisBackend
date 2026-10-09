// The AWS side of Oasis, described before it is created: pnpm aws:provision reads what exists (Get/Head/List calls only), decides
// per resource whether it is ok, missing or different, prints that plan with every document it would send, and changes things only
// with --apply. Nothing is ever deleted: rules, statements and CORS entries it does not own are kept, and a re-run after apply finds
// nothing to do. The only write that is not a create or an update is IAM's own housekeeping (when the oasis-app-runtime policy
// already has the maximum of five versions, the oldest non-default version is removed before the new one is added).
// Without a sender nothing of SES or SNS is read or created; re-running later with --sender adds it (ADR 0132). The runtime identity is
// the instance role oasis-app-role (recommended) or the IAM user oasis-app with a key file (ADR 0133); the EC2 instance is found by
// --instance-id or --private-ip, never through instance metadata, and an instance profile that is already associated is replaced
// only with --replace-instance-profile.
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  CreateBucketCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
  type CORSRule,
  type LifecycleRule,
  type S3Client,
} from '@aws-sdk/client-s3'
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  PutAccountDetailsCommand,
  UpdateConfigurationSetEventDestinationCommand,
  type EventType,
  type SESv2Client,
} from '@aws-sdk/client-sesv2'
import {
  CreateTopicCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
  type SNSClient,
} from '@aws-sdk/client-sns'
import {
  AddRoleToInstanceProfileCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreateInstanceProfileCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateRoleCommand,
  CreateUserCommand,
  DeletePolicyVersionCommand,
  GetInstanceProfileCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetUserCommand,
  ListAccessKeysCommand,
  ListAttachedRolePoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListPolicyVersionsCommand,
  UpdateAssumeRolePolicyCommand,
  type IAMClient,
} from '@aws-sdk/client-iam'
import {
  AssociateIamInstanceProfileCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstancesCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  type EC2Client,
  type Instance,
} from '@aws-sdk/client-ec2'
import { CreateSecretCommand, DescribeSecretCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { STSClient } from '@aws-sdk/client-sts'
import {
  PUBLIC_ACCESS_BLOCK,
  ROLE_TRUST_POLICY,
  SES_EVENT_TYPES,
  SSE_S3,
  TOPIC_DELIVERY_POLICY,
  backupsLifecycle,
  names,
  photosCors,
  photosLifecycle,
  runtimePolicy,
  sameDocument,
  secretArnPattern,
  tlsOnlyBucketPolicy,
  topicPolicy,
  type ProvisionSpec,
  type Sender,
} from './documents.js'

export interface Clients {
  s3: S3Client
  ses: SESv2Client
  sns: SNSClient
  iam: IAMClient
  sts: STSClient
  sm: SecretsManagerClient
  ec2: EC2Client
}

export type Change = 'ok' | 'create' | 'update' | 'request' | 'skip'

export interface Step {
  id: string
  title: string
  change: Change
  detail: string
  /** The document apply sends, printed in full by the plan. */
  document?: unknown
  apply?: () => Promise<void>
}

export interface PlanOptions {
  /** runtime=user: where the oasis-app access key goes (AWS credentials file format, mode 0600); required when a key is to be created. */
  out?: string
  /** runtime=role: the EC2 instance to associate the instance profile with (never looked up through instance metadata). */
  instance?: { id: string } | { privateIp: string }
  /** Replace an instance profile that is already associated with the instance (otherwise it is left alone and reported). */
  replaceInstanceProfile?: boolean
  /** Waits between retries while IAM propagates a new instance profile (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
  /** Create a second access key although one exists (key rotation). */
  newAccessKey?: boolean
  /** Submit the SES production-access request (only when explicitly asked). */
  requestProduction?: { websiteUrl: string; useCase: string; contactEmails: string[] }
}

export interface Plan {
  spec: ProvisionSpec
  /** The environment secret's real ARN once it is known (it exists, or apply created it). */
  secretArn?: string
  steps: Step[]
  /** DNS records the domain owner must add (DKIM CNAMEs, DMARC); filled further by apply when an identity is created. */
  dns: string[]
  /** Facts worth printing that are not changes (sandbox state, pending confirmations). */
  notes: string[]
  /** Lines apply adds (where the key went, what SES returned). Never a secret. */
  results: string[]
}

export class ProvisionError extends Error {}

const errName = (e: unknown): string => (e as { name?: string }).name ?? 'Error'
const status = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode

/** Runs a describe call; returns undefined when AWS says the thing does not exist (one of `missing`). */
async function describe<T>(p: Promise<T>, missing: string[]): Promise<T | undefined> {
  try {
    return await p
  } catch (e) {
    if (missing.includes(errName(e))) return undefined
    throw e
  }
}

export const maskKeyId = (id: string): string => `${id.slice(0, 4)}...${id.slice(-4)}`

/** Upserts by an identifying key, keeping everything else (and the position of what it replaces). */
function upsert<T>(current: T[], ours: T[], key: (x: T) => string | undefined): T[] {
  const out = current.map((c) => ours.find((o) => key(o) !== undefined && key(o) === key(c)) ?? c)
  for (const o of ours) if (!current.some((c) => key(c) === key(o))) out.push(o)
  return out
}

interface PolicyDoc {
  Version?: string
  Id?: string
  Statement: Array<{ Sid?: string } & Record<string, unknown>>
}

const parsePolicy = (text: string | undefined): PolicyDoc | undefined => {
  if (!text) return undefined
  const p = JSON.parse(text) as PolicyDoc
  return { ...p, Statement: Array.isArray(p.Statement) ? p.Statement : [p.Statement] }
}

function mergePolicy(current: PolicyDoc | undefined, ours: PolicyDoc): PolicyDoc {
  if (!current) return ours
  return { ...current, Statement: upsert(current.Statement, ours.Statement, (s) => s.Sid) }
}

function configStep(o: {
  id: string
  title: string
  current: unknown
  desired: unknown
  compare?: (current: unknown, desired: unknown) => boolean
  what: string
  put: () => Promise<unknown>
}): Step {
  const same = o.current !== undefined && (o.compare ?? sameDocument)(o.current, o.desired)
  return {
    id: o.id,
    title: o.title,
    change: same ? 'ok' : o.current === undefined ? 'create' : 'update',
    detail: same ? `${o.what}: as wanted` : `${o.what}: ${o.current === undefined ? 'set' : 'replace with'} the document below`,
    document: o.desired,
    ...(same ? {} : { apply: async () => void (await o.put()) }),
  }
}

const corsProjection = (rules: CORSRule[]) =>
  rules.map((r) => ({
    ID: r.ID,
    AllowedOrigins: [...(r.AllowedOrigins ?? [])].sort(),
    AllowedMethods: [...(r.AllowedMethods ?? [])].sort(),
    AllowedHeaders: [...(r.AllowedHeaders ?? [])].sort(),
    ExposeHeaders: [...(r.ExposeHeaders ?? [])].sort(),
    MaxAgeSeconds: r.MaxAgeSeconds,
  }))

const lifecycleProjection = (rules: LifecycleRule[]) =>
  rules.map((r) => ({
    ID: r.ID,
    Status: r.Status,
    Prefix: r.Filter?.Prefix ?? (r as { Prefix?: string }).Prefix ?? '',
    Expiration: r.Expiration?.Days,
    Noncurrent: r.NoncurrentVersionExpiration?.NoncurrentDays,
    Abort: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation,
  }))

async function bucketSteps(c: Clients, spec: ProvisionSpec, kind: 'photos' | 'backups'): Promise<Step[]> {
  const n = names(spec)
  const Bucket = kind === 'photos' ? n.photosBucket : n.backupsBucket
  const title = `S3 ${kind} bucket ${Bucket}`
  let exists: boolean
  try {
    await c.s3.send(new HeadBucketCommand({ Bucket }))
    exists = true
  } catch (e) {
    if (status(e) === 404 || errName(e) === 'NotFound' || errName(e) === 'NoSuchBucket') exists = false
    else if (status(e) === 403)
      throw new ProvisionError(`${Bucket} exists but this identity may not use it (another account owns the name, or the setup policy is wrong)`)
    else if (status(e) === 301) throw new ProvisionError(`${Bucket} exists in another region than ${spec.region}`)
    else throw e
  }
  const steps: Step[] = [
    {
      id: `${kind}.bucket`,
      title,
      change: exists ? 'ok' : 'create',
      detail: exists ? 'exists' : `create in ${spec.region} with Object Ownership BucketOwnerEnforced (ACLs disabled)`,
      ...(exists
        ? {}
        : {
            apply: async () =>
              void (await c.s3.send(
                new CreateBucketCommand({
                  Bucket,
                  ObjectOwnership: 'BucketOwnerEnforced',
                  ...(spec.region === 'us-east-1'
                    ? {}
                    : { CreateBucketConfiguration: { LocationConstraint: spec.region as BucketLocationConstraint } }),
                }),
              )),
          }),
    },
  ]
  const get = async <T>(p: () => Promise<T>, missing: string[]): Promise<T | undefined> => (exists ? describe(p(), missing) : undefined)

  const pab = (await get(() => c.s3.send(new GetPublicAccessBlockCommand({ Bucket })), ['NoSuchPublicAccessBlockConfiguration']))
    ?.PublicAccessBlockConfiguration
  steps.push(
    configStep({
      id: `${kind}.public-access-block`,
      title,
      what: 'Block Public Access (all four settings on)',
      current: pab,
      desired: PUBLIC_ACCESS_BLOCK,
      put: () => c.s3.send(new PutPublicAccessBlockCommand({ Bucket, PublicAccessBlockConfiguration: PUBLIC_ACCESS_BLOCK })),
    }),
  )

  const ownership = (await get(() => c.s3.send(new GetBucketOwnershipControlsCommand({ Bucket })), ['OwnershipControlsNotFoundError']))
    ?.OwnershipControls
  const wantOwnership = { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' as const }] }
  steps.push(
    configStep({
      id: `${kind}.ownership`,
      title,
      what: 'Object Ownership BucketOwnerEnforced',
      // a bucket created by this script already has it
      current: exists ? ownership : wantOwnership,
      desired: wantOwnership,
      put: () => c.s3.send(new PutBucketOwnershipControlsCommand({ Bucket, OwnershipControls: wantOwnership })),
    }),
  )

  const enc = (await get(() => c.s3.send(new GetBucketEncryptionCommand({ Bucket })), ['ServerSideEncryptionConfigurationNotFoundError']))
    ?.ServerSideEncryptionConfiguration
  steps.push(
    configStep({
      id: `${kind}.encryption`,
      title,
      what: 'default encryption SSE-S3 (an existing SSE-KMS default is kept)',
      current: enc,
      desired: SSE_S3,
      compare: (cur) =>
        ['AES256', 'aws:kms', 'aws:kms:dsse'].includes(
          String((cur as typeof SSE_S3).Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? ''),
        ),
      put: () => c.s3.send(new PutBucketEncryptionCommand({ Bucket, ServerSideEncryptionConfiguration: SSE_S3 })),
    }),
  )

  if (kind === 'photos') {
    const cur = (await get(() => c.s3.send(new GetBucketCorsCommand({ Bucket })), ['NoSuchCORSConfiguration']))?.CORSRules
    const desired = { CORSRules: upsert(cur ?? [], photosCors(spec.dashboardOrigins).CORSRules as CORSRule[], (r) => r.ID) }
    steps.push(
      configStep({
        id: 'photos.cors',
        title,
        what: `CORS: POST, GET and HEAD from ${spec.dashboardOrigins.join(', ')}`,
        current: cur ? { CORSRules: cur } : undefined,
        desired,
        compare: (a, b) => sameDocument(corsProjection((a as typeof desired).CORSRules), corsProjection((b as typeof desired).CORSRules)),
        put: () => c.s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: desired })),
      }),
    )
  }
  // Both buckets are versioned: an overwritten or deleted photo or backup can be recovered until its lifecycle rule removes the old
  // version (30 days); the runtime may delete photos, never backups.
  const ver = exists ? (await c.s3.send(new GetBucketVersioningCommand({ Bucket }))).Status : undefined
  steps.push(
    configStep({
      id: `${kind}.versioning`,
      title,
      what: 'versioning enabled',
      current: ver ? { Status: ver } : undefined,
      desired: { Status: 'Enabled' },
      put: () => c.s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } })),
    }),
  )

  const life = (await get(() => c.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket })), ['NoSuchLifecycleConfiguration']))?.Rules
  const ours = (kind === 'photos' ? photosLifecycle(spec) : backupsLifecycle(spec)).Rules as LifecycleRule[]
  const lifeDesired = { Rules: upsert(life ?? [], ours, (r) => r.ID) }
  steps.push(
    configStep({
      id: `${kind}.lifecycle`,
      title,
      what:
        kind === 'photos'
          ? `lifecycle: photos under "${spec.keyPrefix}" expire after ${spec.photoRetentionDays} days (old versions after 30), unfinished uploads after 1 day`
          : `lifecycle: backups expire after ${spec.backupRetentionDays} days (old versions after 30), unfinished uploads after 1 day`,
      current: life ? { Rules: life } : undefined,
      desired: lifeDesired,
      compare: (a, b) =>
        sameDocument(lifecycleProjection((a as typeof lifeDesired).Rules), lifecycleProjection((b as typeof lifeDesired).Rules)),
      put: () => c.s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: lifeDesired })),
    }),
  )

  const pol = parsePolicy((await get(() => c.s3.send(new GetBucketPolicyCommand({ Bucket })), ['NoSuchBucketPolicy']))?.Policy)
  const polDesired = mergePolicy(pol, tlsOnlyBucketPolicy(Bucket) as PolicyDoc)
  steps.push(
    configStep({
      id: `${kind}.policy`,
      title,
      what: 'bucket policy: deny any request without TLS',
      current: pol,
      desired: polDesired,
      put: () => c.s3.send(new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(polDesired) })),
    }),
  )
  return steps
}

async function identityStep(c: Clients, spec: ProvisionSpec, plan: Plan, identity: string, role: 'sender' | 'recipient'): Promise<Step> {
  const cur = await describe(c.ses.send(new GetEmailIdentityCommand({ EmailIdentity: identity })), ['NotFoundException'])
  const domain = !identity.includes('@')
  const masked = domain ? identity : `${identity[0]}***${identity.slice(identity.indexOf('@'))}`
  const title = `SES ${role === 'sender' ? 'sending identity' : 'sandbox recipient'} ${masked}`
  const dkim = (tokens: string[] | undefined): void => {
    for (const t of tokens ?? []) plan.dns.push(`CNAME  ${t}._domainkey.${identity}  ->  ${t}.dkim.amazonses.com`)
  }
  if (cur) {
    if (domain) dkim(cur.DkimAttributes?.Tokens)
    const verified = cur.VerifiedForSendingStatus === true
    if (!verified)
      plan.notes.push(
        domain
          ? `${identity} is not verified yet (DKIM ${cur.DkimAttributes?.Status ?? 'unknown'}): add the DNS records below and wait for SUCCESS`
          : `${masked} is not verified yet: open the link SES emailed to it`,
      )
    return { id: `ses.identity.${identity}`, title, change: 'ok', detail: `exists, verified for sending: ${verified}${domain ? `, DKIM ${cur.DkimAttributes?.Status ?? 'unknown'}` : ''}` }
  }
  return {
    id: `ses.identity.${identity}`,
    title,
    change: 'create',
    detail: domain
      ? 'create the domain identity with Easy DKIM (RSA 2048); the three CNAME records are printed after apply'
      : 'create the address identity; SES emails a verification link to it',
    apply: async () => {
      const r = await c.ses.send(new CreateEmailIdentityCommand({ EmailIdentity: identity }))
      if (domain) {
        dkim(r.DkimAttributes?.Tokens)
        plan.results.push(`SES created ${identity}; DKIM ${r.DkimAttributes?.Status ?? 'PENDING'} until the CNAME records exist`)
      } else plan.results.push(`SES emailed a verification link to ${masked}`)
    },
  }
}

async function topicSteps(c: Clients, spec: ProvisionSpec, plan: Plan): Promise<{ steps: Step[]; exists: boolean }> {
  const n = names(spec)
  const title = `SNS topic ${n.topic}`
  const attrs = (await describe(c.sns.send(new GetTopicAttributesCommand({ TopicArn: n.topicArn })), ['NotFoundException', 'NotFound']))
    ?.Attributes
  const ourPolicy = topicPolicy(spec) as PolicyDoc
  if (!attrs) {
    return {
      exists: false,
      steps: [
        {
          id: 'sns.topic',
          title,
          change: 'create',
          detail: `create (Standard; SES does not publish to FIFO) with the access policy and the HTTPS delivery policy below; ARN ${n.topicArn}`,
          document: { Policy: ourPolicy, DeliveryPolicy: TOPIC_DELIVERY_POLICY },
          apply: async () =>
            void (await c.sns.send(
              new CreateTopicCommand({
                Name: n.topic,
                Attributes: { Policy: JSON.stringify(ourPolicy), DeliveryPolicy: JSON.stringify(TOPIC_DELIVERY_POLICY) },
                Tags: [{ Key: 'app', Value: 'oasis' }],
              }),
            )),
        },
      ],
    }
  }
  const current = parsePolicy(attrs.Policy)
  // keep AWS's default owner statement (or any other) and add the SES statement
  const sesStatement = ourPolicy.Statement.filter((s) => s.Sid === 'SesPublishesFeedback')
  const policy = current ? { ...current, Statement: upsert(current.Statement, sesStatement, (s) => s.Sid) } : ourPolicy
  const delivery = attrs.DeliveryPolicy ? (JSON.parse(attrs.DeliveryPolicy) as unknown) : undefined
  plan.notes.push(`topic ${n.topicArn} exists`)
  return {
    exists: true,
    steps: [
      { id: 'sns.topic', title, change: 'ok', detail: `exists: ${n.topicArn}` },
      configStep({
        id: 'sns.topic-policy',
        title,
        what: 'access policy: SES may publish for the configuration set',
        current,
        desired: policy,
        put: () => c.sns.send(new SetTopicAttributesCommand({ TopicArn: n.topicArn, AttributeName: 'Policy', AttributeValue: JSON.stringify(policy) })),
      }),
      configStep({
        id: 'sns.delivery-policy',
        title,
        what: 'HTTPS delivery policy: 12 retries over about 25 minutes',
        current: delivery,
        desired: TOPIC_DELIVERY_POLICY,
        put: () =>
          c.sns.send(
            new SetTopicAttributesCommand({ TopicArn: n.topicArn, AttributeName: 'DeliveryPolicy', AttributeValue: JSON.stringify(TOPIC_DELIVERY_POLICY) }),
          ),
      }),
    ],
  }
}

async function subscriptionStep(c: Clients, spec: ProvisionSpec, topicExists: boolean, plan: Plan): Promise<Step> {
  const n = names(spec)
  const title = `SNS subscription ${n.topic} -> ${spec.hooksUrl ?? '(no --hooks-url)'}`
  if (!spec.hooksUrl)
    return { id: 'sns.subscription', title, change: 'skip', detail: 'pass --hooks-url https://<public host>/hooks/ses to subscribe the app' }
  const subs: Array<{ Protocol?: string; Endpoint?: string; SubscriptionArn?: string }> = []
  if (topicExists) {
    let NextToken: string | undefined
    do {
      const r = await c.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: n.topicArn, ...(NextToken ? { NextToken } : {}) }))
      subs.push(...(r.Subscriptions ?? []))
      NextToken = r.NextToken
    } while (NextToken)
  }
  const mine = subs.find((s) => s.Protocol === 'https' && s.Endpoint === spec.hooksUrl)
  const subscribe = async (): Promise<void> => {
    await c.sns.send(new SubscribeCommand({ TopicArn: n.topicArn, Protocol: 'https', Endpoint: spec.hooksUrl }))
    plan.results.push(`SNS sent a SubscriptionConfirmation to ${spec.hooksUrl}; the app confirms it when SES_SNS_TOPIC_ARNS contains ${n.topicArn}`)
  }
  if (!mine) return { id: 'sns.subscription', title, change: 'create', detail: 'subscribe the HTTPS endpoint (the app confirms it itself)', apply: subscribe }
  if (mine.SubscriptionArn === 'PendingConfirmation' || mine.SubscriptionArn === 'pending confirmation')
    return {
      id: 'sns.subscription',
      title,
      change: 'request',
      detail: 'pending confirmation: subscribe again so SNS resends the confirmation (set SES_SNS_TOPIC_ARNS and restart the API first)',
      apply: subscribe,
    }
  return { id: 'sns.subscription', title, change: 'ok', detail: 'confirmed' }
}

async function configurationSetSteps(c: Clients, spec: ProvisionSpec): Promise<Step[]> {
  const n = names(spec)
  const title = `SES configuration set ${n.configurationSet}`
  const cs = await describe(c.ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: n.configurationSet })), ['NotFoundException'])
  const destination = {
    Enabled: true,
    MatchingEventTypes: [...SES_EVENT_TYPES] as EventType[],
    SnsDestination: { TopicArn: n.topicArn },
  }
  const steps: Step[] = [
    {
      id: 'ses.configuration-set',
      title,
      change: cs ? 'ok' : 'create',
      detail: cs ? 'exists' : 'create (reputation metrics on, sending enabled)',
      ...(cs
        ? {}
        : {
            apply: async () =>
              void (await c.ses.send(
                new CreateConfigurationSetCommand({
                  ConfigurationSetName: n.configurationSet,
                  ReputationOptions: { ReputationMetricsEnabled: true },
                  SendingOptions: { SendingEnabled: true },
                }),
              )),
          }),
    },
  ]
  const dests = cs
    ? ((await c.ses.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: n.configurationSet }))).EventDestinations ?? [])
    : []
  const cur = dests.find((d) => d.Name === n.eventDestination)
  const same =
    !!cur &&
    cur.Enabled === true &&
    cur.SnsDestination?.TopicArn === n.topicArn &&
    sameDocument([...(cur.MatchingEventTypes ?? [])].sort(), [...SES_EVENT_TYPES].sort())
  steps.push({
    id: 'ses.event-destination',
    title,
    change: same ? 'ok' : cur ? 'update' : 'create',
    detail: `event destination ${n.eventDestination}: ${SES_EVENT_TYPES.join(', ')} to ${n.topic}`,
    document: destination,
    ...(same
      ? {}
      : {
          apply: async () =>
            void (await c.ses.send(
              cur
                ? new UpdateConfigurationSetEventDestinationCommand({
                    ConfigurationSetName: n.configurationSet,
                    EventDestinationName: n.eventDestination,
                    EventDestination: destination,
                  })
                : new CreateConfigurationSetEventDestinationCommand({
                    ConfigurationSetName: n.configurationSet,
                    EventDestinationName: n.eventDestination,
                    EventDestination: destination,
                  }),
            )),
        }),
  })
  return steps
}

const NO_ENTITY = ['NoSuchEntityException', 'NoSuchEntity']

async function secretStep(c: Clients, spec: ProvisionSpec, plan: Plan): Promise<Step> {
  const title = `Secrets Manager secret ${spec.secretId}`
  const d = await describe(c.sm.send(new DescribeSecretCommand({ SecretId: spec.secretId })), ['ResourceNotFoundException'])
  if (d) {
    if (d.DeletedDate)
      throw new ProvisionError(`${spec.secretId} is scheduled for deletion: restore it first (aws secretsmanager restore-secret --secret-id ${spec.secretId})`)
    plan.secretArn = d.ARN
    if (d.KmsKeyId && !/alias\/aws\/secretsmanager$/.test(d.KmsKeyId))
      plan.notes.push(`${spec.secretId} is encrypted with the key ${d.KmsKeyId}: the runtime also needs kms:Decrypt on it, which oasis-app-runtime does not grant`)
    return { id: 'secret', title, change: 'ok', detail: `exists: ${d.ARN} (its values are never read or changed here; pnpm secrets:push fills it)` }
  }
  return {
    id: 'secret',
    title,
    change: 'create',
    detail: 'create it holding an empty JSON object, with the AWS-managed key aws/secretsmanager, tagged app=oasis (pnpm secrets:push fills it)',
    apply: async () => {
      const r = await c.sm.send(
        new CreateSecretCommand({
          Name: spec.secretId,
          Description: 'Oasis Auto Spa application environment (OASIS_SECRET_ID); written with pnpm secrets:push',
          SecretString: '{}',
          Tags: [{ Key: 'app', Value: 'oasis' }],
        }),
      )
      plan.secretArn = r.ARN
      plan.results.push(`created the secret ${r.ARN ?? spec.secretId} (empty: fill it with pnpm secrets:push)`)
    },
  }
}

/** The runtime policy as apply will send it: with the secret's real ARN once known. */
const desiredPolicy = (plan: Plan): object => runtimePolicy(plan.spec, plan.secretArn ?? secretArnPattern(plan.spec))

async function policyStep(c: Clients, spec: ProvisionSpec, plan: Plan): Promise<Step> {
  const n = names(spec)
  const desired = desiredPolicy(plan)
  const policy = await describe(c.iam.send(new GetPolicyCommand({ PolicyArn: n.policyArn })), NO_ENTITY)
  if (!policy?.Policy)
    return {
      id: 'iam.policy',
      title: `IAM policy ${n.policy}`,
      change: 'create',
      detail: 'create the managed policy (least privilege, below)',
      document: desired,
      apply: async () =>
        void (await c.iam.send(
          new CreatePolicyCommand({
            PolicyName: n.policy,
            PolicyDocument: JSON.stringify(desiredPolicy(plan)),
            Description: 'Oasis app runtime: its environment secret, photos and backups in S3, sending email through SES',
          }),
        )),
    }
  const v = await c.iam.send(new GetPolicyVersionCommand({ PolicyArn: n.policyArn, VersionId: policy.Policy.DefaultVersionId }))
  const current = JSON.parse(decodeURIComponent(v.PolicyVersion?.Document ?? '%7B%7D')) as unknown
  const same = sameDocument(current, desired)
  return {
    id: 'iam.policy',
    title: `IAM policy ${n.policy}`,
    change: same ? 'ok' : 'update',
    detail: same ? `default version ${policy.Policy.DefaultVersionId} is the document below` : 'add a new default version with the document below',
    document: desired,
    ...(same
      ? {}
      : {
          apply: async () => {
            const versions = (await c.iam.send(new ListPolicyVersionsCommand({ PolicyArn: n.policyArn }))).Versions ?? []
            if (versions.length >= 5) {
              const oldest = versions
                .filter((x) => !x.IsDefaultVersion)
                .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0]
              if (oldest?.VersionId) {
                await c.iam.send(new DeletePolicyVersionCommand({ PolicyArn: n.policyArn, VersionId: oldest.VersionId }))
                plan.results.push(`removed the oldest non-default version ${oldest.VersionId} of ${n.policy} (IAM keeps at most five)`)
              }
            }
            await c.iam.send(new CreatePolicyVersionCommand({ PolicyArn: n.policyArn, PolicyDocument: JSON.stringify(desiredPolicy(plan)), SetAsDefault: true }))
          },
        }),
  }
}

/** runtime=user: the IAM user oasis-app with the policy and one access key, written to --out in the AWS credentials file format. */
async function userSteps(c: Clients, spec: ProvisionSpec, plan: Plan, o: PlanOptions): Promise<Step[]> {
  const n = names(spec)
  const steps: Step[] = []
  const user = await describe(c.iam.send(new GetUserCommand({ UserName: n.user })), NO_ENTITY)
  steps.push({
    id: 'iam.user',
    title: `IAM user ${n.user}`,
    change: user ? 'ok' : 'create',
    detail: user ? 'exists' : 'create (no console password, tagged app=oasis)',
    ...(user
      ? {}
      : { apply: async () => void (await c.iam.send(new CreateUserCommand({ UserName: n.user, Tags: [{ Key: 'app', Value: 'oasis' }] }))) }),
  })

  const attached = user
    ? ((await c.iam.send(new ListAttachedUserPoliciesCommand({ UserName: n.user }))).AttachedPolicies ?? []).some((p) => p.PolicyArn === n.policyArn)
    : false
  steps.push({
    id: 'iam.attach',
    title: `IAM user ${n.user}`,
    change: attached ? 'ok' : 'create',
    detail: `${n.policy} ${attached ? 'is attached' : 'attach'}`,
    ...(attached ? {} : { apply: async () => void (await c.iam.send(new AttachUserPolicyCommand({ UserName: n.user, PolicyArn: n.policyArn }))) }),
  })

  const keys = user ? ((await c.iam.send(new ListAccessKeysCommand({ UserName: n.user }))).AccessKeyMetadata ?? []) : []
  const listed = keys.map((k) => `${maskKeyId(k.AccessKeyId ?? '')} (${k.Status})`).join(', ')
  const wantKey = keys.length === 0 || o.newAccessKey === true
  if (wantKey && keys.length >= 2)
    throw new ProvisionError(`${n.user} already has two access keys (${listed}); deactivate and delete the old one by hand before --new-access-key`)
  if (wantKey && !o.out) {
    steps.push({ id: 'iam.access-key', title: `IAM user ${n.user}`, change: 'create', detail: 'create one access key: pass --out <file> (written with mode 0600, never printed)' })
  } else if (wantKey) {
    const out = path.resolve(o.out!)
    steps.push({
      id: 'iam.access-key',
      title: `IAM user ${n.user}`,
      change: 'create',
      detail: `create one access key and write it to ${out} (AWS credentials file, mode 0600, never printed)${keys.length ? `; the existing ${listed} stays until you deactivate it` : ''}`,
      apply: async () => {
        const r = await c.iam.send(new CreateAccessKeyCommand({ UserName: n.user }))
        const k = r.AccessKey
        if (!k?.AccessKeyId || !k.SecretAccessKey) throw new ProvisionError('IAM returned no access key')
        writeFileSync(
          out,
          `# ${n.user} access key created by pnpm aws:provision --runtime user. Install it as /etc/oasis/aws-credentials (owner root, mode 0600):\n` +
            `#   sudo install -o root -g root -m 0600 ${out} /etc/oasis/aws-credentials && shred -u ${out}\n` +
            `[default]\naws_access_key_id = ${k.AccessKeyId}\naws_secret_access_key = ${k.SecretAccessKey}\n`,
          { mode: 0o600, flag: 'wx' },
        )
        plan.results.push(`access key ${maskKeyId(k.AccessKeyId)} written to ${out} (mode 0600)`)
      },
    })
  } else {
    steps.push({ id: 'iam.access-key', title: `IAM user ${n.user}`, change: 'ok', detail: `has ${listed}; pass --new-access-key to rotate` })
  }
  return steps
}

/** runtime=role: the role oasis-app-role (EC2 only) with the policy, the instance profile holding it, and the association. */
async function roleSteps(c: Clients, spec: ProvisionSpec, plan: Plan, o: PlanOptions): Promise<Step[]> {
  const n = names(spec)
  const steps: Step[] = []
  const role = await describe(c.iam.send(new GetRoleCommand({ RoleName: n.role })), NO_ENTITY)
  if (!role?.Role)
    steps.push({
      id: 'iam.role',
      title: `IAM role ${n.role}`,
      change: 'create',
      detail: 'create, assumable only by EC2 (trust policy below), tagged app=oasis',
      document: ROLE_TRUST_POLICY,
      apply: async () =>
        void (await c.iam.send(
          new CreateRoleCommand({
            RoleName: n.role,
            AssumeRolePolicyDocument: JSON.stringify(ROLE_TRUST_POLICY),
            Description: 'Oasis Auto Spa app on its EC2 host (instance profile oasis-app-profile)',
            Tags: [{ Key: 'app', Value: 'oasis' }],
          }),
        )),
    })
  else {
    const trust = JSON.parse(decodeURIComponent(role.Role.AssumeRolePolicyDocument ?? '%7B%7D')) as unknown
    const same = sameDocument(trust, ROLE_TRUST_POLICY)
    steps.push({
      id: 'iam.role',
      title: `IAM role ${n.role}`,
      change: same ? 'ok' : 'update',
      detail: same ? 'exists, assumable only by EC2' : 'replace the trust policy with the one below (only EC2 may assume the role)',
      document: ROLE_TRUST_POLICY,
      ...(same
        ? {}
        : { apply: async () => void (await c.iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: n.role, PolicyDocument: JSON.stringify(ROLE_TRUST_POLICY) }))) }),
    })
  }

  const attached = role?.Role
    ? ((await c.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: n.role }))).AttachedPolicies ?? []).some((p) => p.PolicyArn === n.policyArn)
    : false
  steps.push({
    id: 'iam.role-attach',
    title: `IAM role ${n.role}`,
    change: attached ? 'ok' : 'create',
    detail: `${n.policy} ${attached ? 'is attached' : 'attach'}`,
    ...(attached ? {} : { apply: async () => void (await c.iam.send(new AttachRolePolicyCommand({ RoleName: n.role, PolicyArn: n.policyArn }))) }),
  })

  const profile = (await describe(c.iam.send(new GetInstanceProfileCommand({ InstanceProfileName: n.instanceProfile })), NO_ENTITY))?.InstanceProfile
  steps.push({
    id: 'iam.instance-profile',
    title: `IAM instance profile ${n.instanceProfile}`,
    change: profile ? 'ok' : 'create',
    detail: profile ? 'exists' : 'create, tagged app=oasis',
    ...(profile
      ? {}
      : {
          apply: async () =>
            void (await c.iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: n.instanceProfile, Tags: [{ Key: 'app', Value: 'oasis' }] }))),
        }),
  })
  const held = (profile?.Roles ?? []).map((r) => r.RoleName)
  const others = held.filter((r) => r !== n.role)
  if (others.length)
    throw new ProvisionError(`${n.instanceProfile} already holds the role ${others.join(', ')} (an instance profile holds one role); it is not ours to change`)
  steps.push({
    id: 'iam.instance-profile-role',
    title: `IAM instance profile ${n.instanceProfile}`,
    change: held.includes(n.role) ? 'ok' : 'create',
    detail: held.includes(n.role) ? `holds ${n.role}` : `add ${n.role}`,
    ...(held.includes(n.role)
      ? {}
      : { apply: async () => void (await c.iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: n.instanceProfile, RoleName: n.role }))) }),
  })
  steps.push(await associationStep(c, spec, plan, o))

  // a host that ran with runtime=user before: its key keeps working until someone deactivates it
  const user = await describe(c.iam.send(new GetUserCommand({ UserName: n.user })), NO_ENTITY)
  if (user)
    plan.notes.push(
      `the IAM user ${n.user} exists from a runtime=user setup: once the services run on the role, remove /etc/oasis/aws-credentials and deactivate its access key (the owner, in the IAM console)`,
    )
  return steps
}

const describeInstance = (i: Instance): string => {
  const name = i.Tags?.find((t) => t.Key === 'Name')?.Value
  return `${i.InstanceId}${name ? ` "${name}"` : ''} (${i.State?.Name ?? 'unknown'}, private IP ${i.PrivateIpAddress ?? 'none'})`
}

async function findInstance(c: Clients, where: NonNullable<PlanOptions['instance']>): Promise<Instance> {
  if ('id' in where) {
    let r
    try {
      r = await c.ec2.send(new DescribeInstancesCommand({ InstanceIds: [where.id] }))
    } catch (e) {
      if (errName(e) === 'InvalidInstanceID.NotFound' || errName(e) === 'InvalidInstanceID.Malformed')
        throw new ProvisionError(`--instance-id ${where.id}: no such instance in this account and region`)
      throw e
    }
    const found = (r.Reservations ?? []).flatMap((x) => x.Instances ?? [])
    if (found.length !== 1) throw new ProvisionError(`--instance-id ${where.id}: no such instance in this account and region`)
    return found[0]!
  }
  const found: Instance[] = []
  let NextToken: string | undefined
  do {
    const r = await c.ec2.send(
      new DescribeInstancesCommand({ Filters: [{ Name: 'private-ip-address', Values: [where.privateIp] }], ...(NextToken ? { NextToken } : {}) }),
    )
    found.push(...(r.Reservations ?? []).flatMap((x) => x.Instances ?? []).filter((i) => i.State?.Name !== 'terminated'))
    NextToken = r.NextToken
  } while (NextToken)
  if (found.length === 0) throw new ProvisionError(`--private-ip ${where.privateIp}: no instance has this private address in this account and region`)
  if (found.length > 1)
    throw new ProvisionError(`--private-ip ${where.privateIp} matches ${found.length} instances (${found.map(describeInstance).join('; ')}): pass --instance-id`)
  return found[0]!
}

async function associationStep(c: Clients, spec: ProvisionSpec, plan: Plan, o: PlanOptions): Promise<Step> {
  const n = names(spec)
  const title = `EC2 instance profile association`
  if (!o.instance)
    return {
      id: 'ec2.association',
      title,
      change: 'skip',
      detail: `pass --instance-id i-... or --private-ip <address> to associate ${n.instanceProfile} with the app host (instance metadata is never read to find it)`,
    }
  const instance = await findInstance(c, o.instance)
  const id = instance.InstanceId!
  const assoc = ((await c.ec2.send(new DescribeIamInstanceProfileAssociationsCommand({ Filters: [{ Name: 'instance-id', Values: [id] }] })))
    .IamInstanceProfileAssociations ?? []).filter((a) => a.State === 'associated' || a.State === 'associating')
  const current = assoc[0]
  const ours = (arn: string | undefined): boolean => !!arn && arn.split('/').pop() === n.instanceProfile && arn.includes(`:${spec.account}:`)
  plan.notes.push(
    `instance ${describeInstance(instance)}: ${current ? `instance profile ${current.IamInstanceProfile?.Arn ?? '?'} is ${current.State} (${current.AssociationId})` : 'no instance profile associated'}`,
  )
  const titled = `${title} ${id}`
  if (current && ours(current.IamInstanceProfile?.Arn))
    return { id: 'ec2.association', title: titled, change: 'ok', detail: `${n.instanceProfile} is ${current.State}` }
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // a profile created a moment ago is not yet visible to EC2 (IAM propagates within seconds): retry a few times
  const withRetry = async (send: () => Promise<unknown>): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await send()
        return
      } catch (e) {
        if (errName(e) !== 'InvalidParameterValue' || attempt >= 10) throw e
        await sleep(3_000)
      }
    }
  }
  if (!current)
    return {
      id: 'ec2.association',
      title: titled,
      change: 'create',
      detail: `associate ${n.instanceProfile} (the services then get the role's credentials from the instance; restart them)`,
      apply: async () => {
        await withRetry(() => c.ec2.send(new AssociateIamInstanceProfileCommand({ InstanceId: id, IamInstanceProfile: { Name: n.instanceProfile } })))
        plan.results.push(`${n.instanceProfile} associated with ${id}`)
      },
    }
  if (!o.replaceInstanceProfile) {
    plan.notes.push(`${id} keeps ${current.IamInstanceProfile?.Arn ?? '?'}: nothing replaced. Pass --replace-instance-profile to replace it with ${n.instanceProfile} (whatever uses that role on this host loses it).`)
    return {
      id: 'ec2.association',
      title: titled,
      change: 'skip',
      detail: `another instance profile is associated (${current.IamInstanceProfile?.Arn ?? '?'}); not replaced without --replace-instance-profile`,
    }
  }
  return {
    id: 'ec2.association',
    title: titled,
    change: 'update',
    detail: `replace ${current.IamInstanceProfile?.Arn ?? '?'} (${current.AssociationId}) with ${n.instanceProfile}`,
    apply: async () => {
      await withRetry(() =>
        c.ec2.send(new ReplaceIamInstanceProfileAssociationCommand({ AssociationId: current.AssociationId, IamInstanceProfile: { Name: n.instanceProfile } })),
      )
      plan.results.push(`${id}: ${current.IamInstanceProfile?.Arn ?? '?'} replaced by ${n.instanceProfile}`)
    },
  }
}

async function accountStep(c: Clients, plan: Plan, o: PlanOptions): Promise<Step | undefined> {
  const a = await c.ses.send(new GetAccountCommand({}))
  const review = a.Details?.ReviewDetails?.Status
  plan.notes.push(
    a.ProductionAccessEnabled
      ? 'SES: production access is enabled'
      : `SES: the account is in the SANDBOX (only verified recipients, 200 per day)${review ? `; production access request ${review}` : ''}`,
  )
  if (!o.requestProduction) return undefined
  if (a.ProductionAccessEnabled) return { id: 'ses.production', title: 'SES production access', change: 'ok', detail: 'already enabled' }
  if (review === 'PENDING')
    return { id: 'ses.production', title: 'SES production access', change: 'ok', detail: 'a request is already pending review' }
  const req = o.requestProduction
  return {
    id: 'ses.production',
    title: 'SES production access',
    change: 'request',
    detail: `submit the production-access request (TRANSACTIONAL, ${req.websiteUrl})`,
    document: { MailType: 'TRANSACTIONAL', WebsiteURL: req.websiteUrl, UseCaseDescription: req.useCase, ContactLanguage: 'EN', AdditionalContactEmailAddresses: req.contactEmails },
    apply: async () => {
      await c.ses.send(
        new PutAccountDetailsCommand({
          ProductionAccessEnabled: true,
          MailType: 'TRANSACTIONAL',
          WebsiteURL: req.websiteUrl,
          UseCaseDescription: req.useCase,
          ContactLanguage: 'EN',
          ...(req.contactEmails.length ? { AdditionalContactEmailAddresses: req.contactEmails } : {}),
        }),
      )
      plan.results.push('SES production access requested; AWS answers by email, usually within a day')
    },
  }
}

/** Reads the account (describe calls only) and decides every step. */
export async function buildPlan(c: Clients, spec: ProvisionSpec, o: PlanOptions = {}): Promise<Plan> {
  const plan: Plan = { spec, steps: [], dns: [], notes: [], results: [] }
  if (o.out && existsSync(o.out)) throw new ProvisionError(`--out ${o.out} already exists; choose a new file (the key is written once)`)
  if (o.out && !statSync(path.dirname(path.resolve(o.out))).isDirectory()) throw new ProvisionError(`--out: ${path.dirname(o.out)} is not a directory`)
  plan.steps.push(...(await bucketSteps(c, spec, 'photos')))
  plan.steps.push(...(await bucketSteps(c, spec, 'backups')))
  plan.steps.push(await secretStep(c, spec, plan))
  const sender: Sender | undefined = spec.sender
  if (sender) {
    plan.steps.push(await identityStep(c, spec, plan, sender.identity, 'sender'))
    for (const r of spec.sandboxRecipients) plan.steps.push(await identityStep(c, spec, plan, r, 'recipient'))
    const topic = await topicSteps(c, spec, plan)
    plan.steps.push(...topic.steps)
    plan.steps.push(...(await configurationSetSteps(c, spec)))
    plan.steps.push(await subscriptionStep(c, spec, topic.exists, plan))
  } else
    plan.steps.push({
      id: 'ses',
      title: 'SES and SNS',
      change: 'skip',
      detail: 'no --sender: no identity, configuration set, feedback topic or subscription, and no SES statement in the policy; re-run with --sender later',
    })
  plan.steps.push(await policyStep(c, spec, plan))
  plan.steps.push(...(spec.runtime === 'role' ? await roleSteps(c, spec, plan, o) : await userSteps(c, spec, plan, o)))
  if (sender) {
    const account = await accountStep(c, plan, o)
    if (account) plan.steps.push(account)
    if (sender.kind === 'domain')
      plan.dns.push(`TXT    _dmarc.${sender.domain}  ->  "v=DMARC1; p=none; rua=mailto:dmarc@${sender.domain}"   (recommended)`)
  }
  return plan
}

export async function applyPlan(plan: Plan, log: (line: string) => void): Promise<number> {
  let n = 0
  for (const s of plan.steps) {
    if (!s.apply) continue
    log(`applying  ${s.title}: ${s.detail}`)
    await s.apply()
    n += 1
  }
  return n
}

const MARK: Record<Change, string> = { ok: '=', create: '+', update: '~', request: '!', skip: '-' }

export function renderPlan(plan: Plan): string[] {
  const n = names(plan.spec)
  const out: string[] = []
  out.push(`AWS account ${plan.spec.account}, region ${plan.spec.region}, name prefix "${plan.spec.prefix}"`)
  out.push('')
  out.push('Plan (= as wanted, + create, ~ update, ! request, - skipped):')
  for (const s of plan.steps) out.push(`  ${MARK[s.change]} ${s.title}: ${s.detail}`)
  const docs = plan.steps.filter((s) => s.document !== undefined && s.change !== 'ok' && s.change !== 'skip')
  if (docs.length) {
    out.push('')
    out.push('Documents sent by apply:')
    for (const s of docs) {
      out.push(`--- ${s.title} (${s.id})`)
      out.push(JSON.stringify(s.document, null, 2))
    }
  }
  out.push('')
  out.push(`The app's runtime policy (${n.policy}, attached to ${plan.spec.runtime === 'role' ? `the role ${n.role}` : `the user ${n.user}`}), in full:`)
  out.push(JSON.stringify(desiredPolicy(plan), null, 2))
  if (!plan.secretArn) out.push(`(the secret does not exist yet: "-??????" stands for the suffix AWS appends; apply uses the real ARN)`)
  if (plan.notes.length) {
    out.push('')
    for (const x of plan.notes) out.push(`note: ${x}`)
  }
  const changes = plan.steps.filter((s) => s.apply).length
  out.push('')
  out.push(changes === 0 ? 'Nothing to change.' : `${changes} change(s).`)
  return out
}

/** The non-secret settings the app needs afterwards, for /etc/oasis/common.env (secrets go to the secret with pnpm secrets:push). */
export function envLines(spec: ProvisionSpec): string[] {
  const n = names(spec)
  const sender = spec.sender
  return [
    `OASIS_SECRET_ID=${spec.secretId}`,
    `AWS_REGION=${spec.region}`,
    spec.runtime === 'role'
      ? '# runtime=role: no AWS credentials anywhere on the host; the SDK uses the instance role (leave AWS_EC2_METADATA_DISABLED unset)'
      : '# runtime=user: install the --out file as /etc/oasis/aws-credentials (root, 0600); the units hand it to the services',
    'STORAGE_PROVIDER=s3',
    `S3_BUCKET=${n.photosBucket}`,
    `S3_KEY_PREFIX=${spec.keyPrefix}`,
    `BACKUP_S3_URI=s3://${n.backupsBucket}/db/`,
    ...(sender
      ? [
          'EMAIL_PROVIDER=ses',
          `SES_FROM_ADDRESS=${sender.kind === 'address' ? sender.identity : `no-reply@${sender.domain}`}`,
          `SES_CONFIGURATION_SET=${n.configurationSet}`,
          `SES_SNS_TOPIC_ARNS=${n.topicArn}`,
        ]
      : ['# email: EMAIL_PROVIDER stays sim until a sender exists (re-run with --sender, then set the SES_* lines it prints)']),
  ]
}
