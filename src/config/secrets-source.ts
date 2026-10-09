// The production environment lives in one AWS Secrets Manager secret (docs/deployment.md, ADR 0130). Every program that reads the
// application environment calls loadRuntimeEnv() (or applySecretEnvironment() when it reads process.env itself) instead of
// loadEnv(): when OASIS_SECRET_ID is set, the secret is fetched ONCE, must be a JSON object of string values whose keys the
// environment contract declares, and fills the process environment keys that are not already set. Then loadEnv() validates as
// before. Without OASIS_SECRET_ID nothing is fetched (development and tests are unchanged).
//
// Precedence: a variable already set to a non-empty value in the process environment (systemd EnvironmentFile, the shell, .env in
// development) wins over the secret, so one setting can be overridden on one host without touching the secret. An EMPTY value
// counts as unset: an old template's `SESSION_SECRET=` line does not hide the secret's value.
//
// Credentials come from the SDK's default chain: the EC2 instance role (the recommendation), or a credentials file named by
// AWS_SHARED_CREDENTIALS_FILE (runtime=user), or AWS_PROFILE. No value of the secret is ever logged or put in an error message;
// errors name keys at most.
import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager'
import { ENV_KEYS, loadEnv, type Env } from './env.js'

export const SECRET_ID_VAR = 'OASIS_SECRET_ID'

/**
 * Keys that may never come from the secret, with the reason. What is needed to reach the secret has to be known before it is read,
 * and credentials in a secret that the same credentials unlock would protect nothing.
 */
export const FORBIDDEN_SECRET_KEYS: Readonly<Record<string, string>> = {
  OASIS_SECRET_ID: 'names the secret itself',
  AWS_REGION: 'is needed to reach the secret (set it in /etc/oasis/common.env)',
  AWS_ACCESS_KEY_ID: 'is an AWS credential (use the instance role, or /etc/oasis/aws-credentials)',
  AWS_SECRET_ACCESS_KEY: 'is an AWS credential (use the instance role, or /etc/oasis/aws-credentials)',
  AWS_SESSION_TOKEN: 'is an AWS credential',
  AWS_PROFILE: 'selects the credentials used to read the secret',
  AWS_SHARED_CREDENTIALS_FILE: 'selects the credentials used to read the secret',
  AWS_EC2_METADATA_DISABLED: 'decides how the secret is reached',
}

/**
 * The secret material of the environment: these belong in the secret and not in /etc/oasis/*.env (the deploy kit's templates keep
 * them commented out, and tests hold the two lists together).
 */
export const SECRET_KEYS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'SECRETS_KEY',
  'STORAGE_SIGNING_SECRET',
  'BOOTSTRAP_ADMIN_EMAIL',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'SQSP_API_KEY',
  'SQSP_WEBHOOK_SECRET',
  'SMSGATE_PASSWORD',
  'SMSGATE_WEBHOOK_SECRET',
] as const

export class SecretSourceError extends Error {
  override name = 'SecretSourceError'
}

const SECRET_ID = /^[A-Za-z0-9/_+=.@:-]{1,2048}$/

/** Problems with a key set, by kind; empty when every key may live in the secret. Used by the loader and by pnpm secrets:push. */
export function secretKeyProblems(keys: Iterable<string>): { forbidden: string[]; unknown: string[] } {
  const forbidden: string[] = []
  const unknown: string[] = []
  for (const k of keys) {
    if (k in FORBIDDEN_SECRET_KEYS) forbidden.push(k)
    else if (!ENV_KEYS.has(k)) unknown.push(k)
  }
  return { forbidden: forbidden.sort(), unknown: unknown.sort() }
}

/** Parses the secret's text into NAME -> value, or throws a SecretSourceError that names keys at most (never a value). */
export function parseSecretDocument(text: string | undefined, secretId: string): Record<string, string> {
  if (text === undefined)
    throw new SecretSourceError(`secret "${secretId}" has no string value (binary secrets are not supported): store a JSON object`)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    // JSON.parse's message quotes the text it choked on, which is secret material: say only that it is not JSON
    throw new SecretSourceError(`secret "${secretId}" is not JSON: store a JSON object of NAME -> string value (pnpm secrets:push does)`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
    throw new SecretSourceError(`secret "${secretId}" must be a JSON object of NAME -> string value, not ${Array.isArray(doc) ? 'an array' : doc === null ? 'null' : `a ${typeof doc}`}`)
  const entries = Object.entries(doc as Record<string, unknown>)
  const nonString = entries.filter(([, v]) => typeof v !== 'string').map(([k, v]) => `${k} (${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v})`)
  if (nonString.length)
    throw new SecretSourceError(`secret "${secretId}": every value must be a string; these are not: ${nonString.sort().join(', ')}`)
  const { forbidden, unknown } = secretKeyProblems(entries.map(([k]) => k))
  if (forbidden.length)
    throw new SecretSourceError(
      `secret "${secretId}" holds keys that must not live there: ${forbidden.map((k) => `${k} (${FORBIDDEN_SECRET_KEYS[k]})`).join(', ')}`,
    )
  if (unknown.length)
    throw new SecretSourceError(
      `secret "${secretId}" holds keys the environment contract (src/config/env.ts) does not declare: ${unknown.join(', ')}; remove them with pnpm secrets:push --remove`,
    )
  return Object.fromEntries(entries) as Record<string, string>
}

const errName = (e: unknown): string => (e as { name?: string }).name ?? 'Error'
const status = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode

/** Turns an SDK failure into one actionable line. AWS error texts carry ARNs and identities, never the secret's value. */
export function describeFetchError(e: unknown, secretId: string, region: string): SecretSourceError {
  const name = errName(e)
  const msg = (e as { message?: string }).message ?? String(e)
  const where = `secret "${secretId}" in ${region}`
  if (name === 'ResourceNotFoundException')
    return new SecretSourceError(`${where} does not exist: create it with pnpm aws:provision --apply and fill it with pnpm secrets:push`)
  if (name === 'AccessDeniedException' || name === 'AccessDenied' || status(e) === 403)
    return new SecretSourceError(
      `access denied reading ${where}: the runtime identity needs secretsmanager:GetSecretValue on it (instance role: is the instance profile oasis-app-profile associated with this instance? runtime user: is AWS_SHARED_CREDENTIALS_FILE the oasis-app key?) (${name}: ${msg})`,
    )
  if (name === 'DecryptionFailure' || name === 'KMSAccessDeniedException')
    return new SecretSourceError(`${where} cannot be decrypted with this identity's KMS rights (${name}: ${msg})`)
  if (name === 'CredentialsProviderError' || /Could not load credentials/i.test(msg))
    return new SecretSourceError(
      `no AWS credentials to read ${where}: on EC2 associate the instance profile oasis-app-profile (runtime=role), or set AWS_SHARED_CREDENTIALS_FILE to the oasis-app key file (runtime=user)`,
    )
  if (name === 'InvalidRequestException' && /deletion/i.test(msg))
    return new SecretSourceError(`${where} is scheduled for deletion: restore it (aws secretsmanager restore-secret) before starting`)
  return new SecretSourceError(`could not read ${where}: ${name}: ${msg}`)
}

export interface SecretSourceOptions {
  /** The environment to read OASIS_SECRET_ID and AWS_REGION from and to fill; default process.env (filled in place). */
  env?: NodeJS.ProcessEnv
  /** The client (tests); default a SecretsManagerClient for AWS_REGION with the default credential chain. */
  client?: (region: string) => Pick<SecretsManagerClient, 'send'>
  /** One line per fetch, names and counts only; default stderr. */
  log?: (line: string) => void
}

export interface SecretSourceResult {
  /** Undefined when OASIS_SECRET_ID is not set (nothing was fetched). */
  secretId?: string
  /** Keys taken from the secret. */
  filled: string[]
  /** Keys the secret has but the process environment already set (the environment won). */
  kept: string[]
}

const defaultClient = (region: string): SecretsManagerClient =>
  new SecretsManagerClient({ region, maxAttempts: 3, requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 } })

const defaultLog = (line: string): void => void process.stderr.write(`${line}\n`)

/** Fetches the secret named by OASIS_SECRET_ID (if any) and fills the unset keys of the environment. Throws SecretSourceError. */
export async function applySecretEnvironment(o: SecretSourceOptions = {}): Promise<SecretSourceResult> {
  const env = o.env ?? process.env
  const secretId = env[SECRET_ID_VAR]?.trim()
  if (!secretId) return { filled: [], kept: [] }
  if (!SECRET_ID.test(secretId)) throw new SecretSourceError(`${SECRET_ID_VAR} is not a secret name or ARN`)
  const region = env.AWS_REGION?.trim()
  if (!region) throw new SecretSourceError(`${SECRET_ID_VAR} is set but AWS_REGION is not: set both in /etc/oasis/common.env`)
  let out: GetSecretValueCommandOutput
  try {
    out = await (o.client ?? defaultClient)(region).send(new GetSecretValueCommand({ SecretId: secretId }))
  } catch (e) {
    throw describeFetchError(e, secretId, region)
  }
  const values = parseSecretDocument(out.SecretString, secretId)
  const filled: string[] = []
  const kept: string[] = []
  for (const [k, v] of Object.entries(values)) {
    if (env[k] !== undefined && env[k] !== '') kept.push(k)
    else {
      env[k] = v
      filled.push(k)
    }
  }
  filled.sort()
  kept.sort()
  ;(o.log ?? defaultLog)(
    `environment: ${filled.length} setting(s) from Secrets Manager secret ${secretId} (${region})` +
      (kept.length ? `; set in the process environment and kept: ${kept.join(', ')}` : ''),
  )
  return { secretId, filled, kept }
}

/** The application's environment: the secret (when OASIS_SECRET_ID is set) under the process environment, then validated. */
export async function loadRuntimeEnv(o: SecretSourceOptions = {}): Promise<Env> {
  await applySecretEnvironment(o)
  return loadEnv(o.env ?? process.env)
}
