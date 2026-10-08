import { z } from 'zod'

/**
 * Storage variables beyond the provider switch, spread into envSchema (src/config/env.ts). Strings and enums only, so
 * re-parsing an already-parsed Env (createStorageProvider does) is a no-op.
 */
export const storageEnvShape = {
  /** Key prefix inside the bucket, e.g. "prod/". Lets one bucket serve several environments. */
  S3_KEY_PREFIX: z.string().default(''),
  /** Per-object encryption header; `none` relies on the bucket default encryption. */
  S3_SSE: z.enum(['none', 'AES256', 'aws:kms']).default('none'),
  S3_KMS_KEY_ID: z.string().optional(),
  /** Custom endpoint for S3-compatible stores and the AWS simulator; leave unset for AWS. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  /** HMAC key for fs dev URLs; falls back to SESSION_SECRET, and to a fixed dev value outside production. */
  STORAGE_SIGNING_SECRET: z.string().min(16).optional(),
}
export const storageEnvFragment = z.object(storageEnvShape)
export type StorageEnvFragment = z.infer<typeof storageEnvFragment>
