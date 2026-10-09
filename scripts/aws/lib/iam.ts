// Which IAM action, on which resource, each AWS API call of pnpm aws:provision needs. The plan prints it next to every step, and
// the tests evaluate every call the script really made against the temporary setup policy in docs/aws-setup.md.

export interface IamCall {
  action: string
  resource: string
  /** Request context keys IAM evaluates for this call (e.g. iam:PolicyARN on AttachUserPolicy). */
  context?: Record<string, string>
}

export interface IamContext {
  region: string
  account: string
}

type Input = Record<string, unknown>

const s3b = (i: Input): string => `arn:aws:s3:::${String(i.Bucket)}`
const ses = (c: IamContext, kind: string, name: unknown): string => `arn:aws:ses:${c.region}:${c.account}:${kind}/${String(name)}`
const user = (c: IamContext, i: Input): string => `arn:aws:iam::${c.account}:user/${String(i.UserName)}`
const role = (c: IamContext, name: unknown): string => `arn:aws:iam::${c.account}:role/${String(name)}`
const profile = (c: IamContext, name: unknown): string => `arn:aws:iam::${c.account}:instance-profile/${String(name)}`
// the suffix Secrets Manager appends is not known before the call; any six characters stand for it
const secret = (c: IamContext, name: unknown): string => `arn:aws:secretsmanager:${c.region}:${c.account}:secret:${String(name)}-AbCdEf`
// AssociateIamInstanceProfile names the profile; IAM checks iam:PassRole on the role it holds (<prefix>-app-profile holds <prefix>-app-role)
const passRole = (c: IamContext, i: Input): IamCall => ({
  action: 'iam:PassRole',
  resource: role(c, String((i.IamInstanceProfile as { Name?: string } | undefined)?.Name ?? '').replace(/-profile$/, '-role')),
  context: { 'iam:PassedToService': 'ec2.amazonaws.com' },
})

const S3_BUCKET_ACTIONS: Record<string, string> = {
  HeadBucketCommand: 's3:ListBucket',
  GetPublicAccessBlockCommand: 's3:GetBucketPublicAccessBlock',
  PutPublicAccessBlockCommand: 's3:PutBucketPublicAccessBlock',
  GetBucketOwnershipControlsCommand: 's3:GetBucketOwnershipControls',
  PutBucketOwnershipControlsCommand: 's3:PutBucketOwnershipControls',
  GetBucketEncryptionCommand: 's3:GetEncryptionConfiguration',
  PutBucketEncryptionCommand: 's3:PutEncryptionConfiguration',
  GetBucketCorsCommand: 's3:GetBucketCORS',
  PutBucketCorsCommand: 's3:PutBucketCORS',
  GetBucketLifecycleConfigurationCommand: 's3:GetLifecycleConfiguration',
  PutBucketLifecycleConfigurationCommand: 's3:PutLifecycleConfiguration',
  GetBucketPolicyCommand: 's3:GetBucketPolicy',
  PutBucketPolicyCommand: 's3:PutBucketPolicy',
  GetBucketVersioningCommand: 's3:GetBucketVersioning',
  PutBucketVersioningCommand: 's3:PutBucketVersioning',
}

const SNS_TOPIC_ACTIONS: Record<string, string> = {
  GetTopicAttributesCommand: 'sns:GetTopicAttributes',
  SetTopicAttributesCommand: 'sns:SetTopicAttributes',
  ListSubscriptionsByTopicCommand: 'sns:ListSubscriptionsByTopic',
  SubscribeCommand: 'sns:Subscribe',
}

const IAM_USER_ACTIONS: Record<string, string> = {
  GetUserCommand: 'iam:GetUser',
  ListAttachedUserPoliciesCommand: 'iam:ListAttachedUserPolicies',
  ListAccessKeysCommand: 'iam:ListAccessKeys',
  CreateAccessKeyCommand: 'iam:CreateAccessKey',
}

const IAM_ROLE_ACTIONS: Record<string, string> = {
  GetRoleCommand: 'iam:GetRole',
  UpdateAssumeRolePolicyCommand: 'iam:UpdateAssumeRolePolicy',
  ListAttachedRolePoliciesCommand: 'iam:ListAttachedRolePolicies',
}

const IAM_POLICY_ACTIONS: Record<string, string> = {
  GetPolicyCommand: 'iam:GetPolicy',
  GetPolicyVersionCommand: 'iam:GetPolicyVersion',
  ListPolicyVersionsCommand: 'iam:ListPolicyVersions',
  CreatePolicyVersionCommand: 'iam:CreatePolicyVersion',
  DeletePolicyVersionCommand: 'iam:DeletePolicyVersion',
}

/** The IAM permissions one SDK command needs. Throws for a command this table does not know, so nothing slips through. */
export function iamCallsOf(command: string, input: Input, c: IamContext): IamCall[] {
  if (command in S3_BUCKET_ACTIONS) return [{ action: S3_BUCKET_ACTIONS[command]!, resource: s3b(input) }]
  if (command in SNS_TOPIC_ACTIONS) return [{ action: SNS_TOPIC_ACTIONS[command]!, resource: String(input.TopicArn) }]
  if (command in IAM_USER_ACTIONS) return [{ action: IAM_USER_ACTIONS[command]!, resource: user(c, input) }]
  if (command in IAM_POLICY_ACTIONS) return [{ action: IAM_POLICY_ACTIONS[command]!, resource: String(input.PolicyArn) }]
  if (command in IAM_ROLE_ACTIONS) return [{ action: IAM_ROLE_ACTIONS[command]!, resource: role(c, input.RoleName) }]
  switch (command) {
    case 'GetCallerIdentityCommand':
      return [{ action: 'sts:GetCallerIdentity', resource: '*' }]
    case 'CreateBucketCommand':
      return [
        { action: 's3:CreateBucket', resource: s3b(input) },
        ...(input.ObjectOwnership ? [{ action: 's3:PutBucketOwnershipControls', resource: s3b(input) }] : []),
      ]
    case 'GetEmailIdentityCommand':
      return [{ action: 'ses:GetEmailIdentity', resource: ses(c, 'identity', input.EmailIdentity) }]
    case 'CreateEmailIdentityCommand':
      return [
        { action: 'ses:CreateEmailIdentity', resource: ses(c, 'identity', input.EmailIdentity) },
        ...(input.Tags ? [{ action: 'ses:TagResource', resource: ses(c, 'identity', input.EmailIdentity) }] : []),
      ]
    case 'GetConfigurationSetCommand':
    case 'CreateConfigurationSetCommand':
    case 'GetConfigurationSetEventDestinationsCommand':
    case 'CreateConfigurationSetEventDestinationCommand':
    case 'UpdateConfigurationSetEventDestinationCommand':
      return [
        { action: `ses:${command.replace(/Command$/, '')}`, resource: ses(c, 'configuration-set', input.ConfigurationSetName) },
        ...(command === 'CreateConfigurationSetCommand' && input.Tags
          ? [{ action: 'ses:TagResource', resource: ses(c, 'configuration-set', input.ConfigurationSetName) }]
          : []),
      ]
    case 'GetAccountCommand':
      return [{ action: 'ses:GetAccount', resource: '*' }]
    case 'PutAccountDetailsCommand':
      return [{ action: 'ses:PutAccountDetails', resource: '*' }]
    case 'CreateTopicCommand': {
      const arn = `arn:aws:sns:${c.region}:${c.account}:${String(input.Name)}`
      return [{ action: 'sns:CreateTopic', resource: arn }, ...(input.Tags ? [{ action: 'sns:TagResource', resource: arn }] : [])]
    }
    case 'CreateUserCommand':
      return [{ action: 'iam:CreateUser', resource: user(c, input) }, ...(input.Tags ? [{ action: 'iam:TagUser', resource: user(c, input) }] : [])]
    case 'AttachUserPolicyCommand':
      return [{ action: 'iam:AttachUserPolicy', resource: user(c, input), context: { 'iam:PolicyARN': String(input.PolicyArn) } }]
    case 'CreateRoleCommand':
      return [
        { action: 'iam:CreateRole', resource: role(c, input.RoleName) },
        ...(input.Tags ? [{ action: 'iam:TagRole', resource: role(c, input.RoleName) }] : []),
      ]
    case 'AttachRolePolicyCommand':
      return [{ action: 'iam:AttachRolePolicy', resource: role(c, input.RoleName), context: { 'iam:PolicyARN': String(input.PolicyArn) } }]
    case 'GetInstanceProfileCommand':
      return [{ action: 'iam:GetInstanceProfile', resource: profile(c, input.InstanceProfileName) }]
    case 'CreateInstanceProfileCommand':
      return [
        { action: 'iam:CreateInstanceProfile', resource: profile(c, input.InstanceProfileName) },
        ...(input.Tags ? [{ action: 'iam:TagInstanceProfile', resource: profile(c, input.InstanceProfileName) }] : []),
      ]
    case 'AddRoleToInstanceProfileCommand':
      return [
        { action: 'iam:AddRoleToInstanceProfile', resource: profile(c, input.InstanceProfileName) },
        { action: 'iam:PassRole', resource: role(c, input.RoleName) },
      ]
    case 'DescribeSecretCommand':
      return [{ action: 'secretsmanager:DescribeSecret', resource: secret(c, input.SecretId) }]
    case 'CreateSecretCommand':
      return [
        { action: 'secretsmanager:CreateSecret', resource: secret(c, input.Name) },
        ...(input.Tags ? [{ action: 'secretsmanager:TagResource', resource: secret(c, input.Name) }] : []),
      ]
    case 'DescribeInstancesCommand':
      return [{ action: 'ec2:DescribeInstances', resource: '*' }]
    case 'DescribeIamInstanceProfileAssociationsCommand':
      return [{ action: 'ec2:DescribeIamInstanceProfileAssociations', resource: '*' }]
    case 'AssociateIamInstanceProfileCommand':
      return [
        { action: 'ec2:AssociateIamInstanceProfile', resource: `arn:aws:ec2:${c.region}:${c.account}:instance/${String(input.InstanceId)}` },
        passRole(c, input),
      ]
    case 'ReplaceIamInstanceProfileAssociationCommand':
      return [{ action: 'ec2:ReplaceIamInstanceProfileAssociation', resource: '*' }, passRole(c, input)]
    case 'CreatePolicyCommand':
      return [
        { action: 'iam:CreatePolicy', resource: `arn:aws:iam::${c.account}:policy${String(input.Path ?? '/')}${String(input.PolicyName)}` },
        ...(input.Tags ? [{ action: 'iam:TagPolicy', resource: `arn:aws:iam::${c.account}:policy/${String(input.PolicyName)}` }] : []),
      ]
  }
  throw new Error(`no IAM mapping for ${command}`)
}

// ---- a small IAM evaluator (Allow statements only, the condition operators the setup policy uses) ----------------------------

export interface PolicyStatement {
  Sid?: string
  Effect: 'Allow' | 'Deny'
  Action: string | string[]
  Resource: string | string[]
  Condition?: Record<string, Record<string, string | string[]>>
}

const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])
const glob = (pattern: string, value: string, caseInsensitive = false): boolean => {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, caseInsensitive ? 'i' : '')
  return re.test(value)
}

function conditionHolds(cond: PolicyStatement['Condition'], call: IamCall, now: Date): boolean {
  for (const [op, keys] of Object.entries(cond ?? {})) {
    for (const [key, expected] of Object.entries(keys)) {
      const values = list(expected)
      if (op === 'DateLessThan' && key === 'aws:CurrentTime') {
        if (!values.some((v) => now.getTime() < Date.parse(v))) return false
      } else if (op === 'ArnLike' || op === 'StringLike') {
        const actual = call.context?.[key]
        if (actual === undefined || !values.some((v) => glob(v, actual))) return false
      } else if (op === 'StringEquals') {
        const actual = call.context?.[key]
        if (actual === undefined || !values.includes(actual)) return false
      } else return false // an operator this evaluator does not model never grants
    }
  }
  return true
}

/** True when an Allow statement grants the call (and no Deny matches). */
export function allowedBy(statements: PolicyStatement[], call: IamCall, now: Date): boolean {
  const matches = (s: PolicyStatement) =>
    list(s.Action).some((a) => glob(a, call.action, true)) &&
    list(s.Resource).some((r) => glob(r, call.resource)) &&
    conditionHolds(s.Condition, call, now)
  if (statements.some((s) => s.Effect === 'Deny' && matches(s))) return false
  return statements.some((s) => s.Effect === 'Allow' && matches(s))
}
