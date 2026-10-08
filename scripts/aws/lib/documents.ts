// Every resource name and JSON document pnpm aws:provision creates, as pure functions of its inputs, so the plan prints exactly
// what apply sends and the tests pin each document.

export type Sender = { kind: 'address'; identity: string; domain: string } | { kind: 'domain'; identity: string; domain: string }

export interface ProvisionSpec {
  region: string
  account: string
  prefix: string
  sender: Sender
  /** Browser origins allowed to POST photos straight to the bucket (the dashboard). */
  dashboardOrigins: string[]
  /** Public https URL of POST /hooks/ses; no subscription without it. */
  hooksUrl?: string
  /** Key prefix of the photos (S3_KEY_PREFIX), "" or ending in "/". */
  keyPrefix: string
  photoRetentionDays: number
  backupRetentionDays: number
  /** Addresses to verify while the account is in the SES sandbox (they also join the send policy). */
  sandboxRecipients: string[]
}

export const names = (s: Pick<ProvisionSpec, 'prefix' | 'account' | 'region'>) => ({
  photosBucket: `${s.prefix}-photos-${s.account}`,
  backupsBucket: `${s.prefix}-backups-${s.account}`,
  topic: `${s.prefix}-ses-events`,
  topicArn: `arn:aws:sns:${s.region}:${s.account}:${s.prefix}-ses-events`,
  configurationSet: `${s.prefix}-mail`,
  eventDestination: `${s.prefix}-sns-events`,
  user: `${s.prefix}-app`,
  userArn: `arn:aws:iam::${s.account}:user/${s.prefix}-app`,
  policy: `${s.prefix}-app-runtime`,
  policyArn: `arn:aws:iam::${s.account}:policy/${s.prefix}-app-runtime`,
})

export const sesArn = (s: Pick<ProvisionSpec, 'region' | 'account'>, kind: 'identity' | 'configuration-set', name: string): string =>
  `arn:aws:ses:${s.region}:${s.account}:${kind}/${name}`

/** Least privilege for the running app (the oasis-app user): photos under the prefix, backups, and sending as the sender. */
export function runtimePolicy(s: ProvisionSpec): object {
  const n = names(s)
  const photos = `arn:aws:s3:::${n.photosBucket}`
  const backups = `arn:aws:s3:::${n.backupsBucket}`
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'PhotoObjects', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'], Resource: `${photos}/${s.keyPrefix}*` },
      // HeadObject of a missing key answers 404 (not 403) only with s3:ListBucket; the app tells "never uploaded" from "denied" by it
      { Sid: 'PhotoHeadMissingKey', Effect: 'Allow', Action: 's3:ListBucket', Resource: photos },
      { Sid: 'BackupObjects', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `${backups}/*` },
      { Sid: 'BackupList', Effect: 'Allow', Action: 's3:ListBucket', Resource: backups },
      {
        Sid: 'SendEmail',
        Effect: 'Allow',
        Action: ['ses:SendEmail', 'ses:SendRawEmail'],
        Resource: [
          sesArn(s, 'identity', s.sender.identity),
          sesArn(s, 'configuration-set', n.configurationSet),
          ...s.sandboxRecipients.map((r) => sesArn(s, 'identity', r)),
        ],
        Condition:
          s.sender.kind === 'address'
            ? { StringEquals: { 'ses:FromAddress': s.sender.identity } }
            : { StringLike: { 'ses:FromAddress': `*@${s.sender.domain}` } },
      },
    ],
  }
}

/** Refuses any request that is not TLS. */
export function tlsOnlyBucketPolicy(bucket: string): object {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
    ],
  }
}

export const PUBLIC_ACCESS_BLOCK = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true }

export const SSE_S3 = { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' as const }, BucketKeyEnabled: false }] }

/** The browser POSTs uploads straight to the bucket and fetches presigned GETs; nothing else. */
export function photosCors(origins: string[]): { CORSRules: object[] } {
  return {
    CORSRules: [
      {
        ID: 'dashboard-uploads',
        AllowedOrigins: [...origins],
        AllowedMethods: ['POST', 'GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3000,
      },
    ],
  }
}

export function photosLifecycle(s: Pick<ProvisionSpec, 'keyPrefix' | 'photoRetentionDays'>): { Rules: object[] } {
  return {
    Rules: [
      { ID: 'expire-photos', Status: 'Enabled', Filter: { Prefix: s.keyPrefix }, Expiration: { Days: s.photoRetentionDays } },
      { ID: 'abort-incomplete-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
    ],
  }
}

export function backupsLifecycle(s: Pick<ProvisionSpec, 'backupRetentionDays'>): { Rules: object[] } {
  return {
    Rules: [
      {
        ID: 'expire-backups',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        Expiration: { Days: s.backupRetentionDays },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
      },
      { ID: 'abort-incomplete-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
    ],
  }
}

/** The topic's access policy: the account keeps its default rights, and SES may publish for our configuration set only. */
export function topicPolicy(s: ProvisionSpec): object {
  const n = names(s)
  return {
    Version: '2012-10-17',
    Id: `${n.topic}-policy`,
    Statement: [
      {
        Sid: 'AccountOwner',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Action: [
          'SNS:GetTopicAttributes',
          'SNS:SetTopicAttributes',
          'SNS:AddPermission',
          'SNS:RemovePermission',
          'SNS:DeleteTopic',
          'SNS:Subscribe',
          'SNS:ListSubscriptionsByTopic',
          'SNS:Publish',
        ],
        Resource: n.topicArn,
        Condition: { StringEquals: { 'AWS:SourceOwner': s.account } },
      },
      {
        Sid: 'SesPublishesFeedback',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 'SNS:Publish',
        Resource: n.topicArn,
        Condition: {
          StringEquals: { 'AWS:SourceAccount': s.account, 'AWS:SourceArn': sesArn(s, 'configuration-set', n.configurationSet) },
        },
      },
    ],
  }
}

/**
 * HTTPS retries for /hooks/ses: 12 attempts over about 25 minutes (SNS caps an HTTP/S policy at 3,600 s), so a restart or a deploy
 * does not lose a bounce. The app rejects messages older than an hour, which this window stays inside.
 */
export const TOPIC_DELIVERY_POLICY = {
  http: {
    defaultHealthyRetryPolicy: {
      minDelayTarget: 10,
      maxDelayTarget: 300,
      numRetries: 12,
      numNoDelayRetries: 0,
      numMinDelayRetries: 2,
      numMaxDelayRetries: 3,
      backoffFunction: 'exponential',
    },
    disableSubscriptionOverrides: false,
  },
}

export const SES_EVENT_TYPES = ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'] as const

/** Canonical JSON (sorted keys, single-element arrays as scalars) so a document AWS echoes back compares equal to ours. */
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    const items = v.map(canonical)
    return items.length === 1 ? items[0] : items
  }
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    )
  return v
}

export const sameDocument = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
