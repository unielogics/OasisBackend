import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import type { Env } from '../../config/env.js'
import { systemClock, type Clock } from '../../platform/clock.js'
import { DEV_STORAGE_PREFIX, FsStorage } from './fs-provider.js'
import { S3Storage, type S3StorageOptions } from './s3-provider.js'
import type { ObjectStorage } from './types.js'

/**
 * Extra variables for the storage integration. env.ts is not edited here: the integrator spreads
 * `storageEnvShape` into envSchema. Strings and enums only, so re-parsing an already-parsed object is a no-op.
 */
export const storageEnvShape = {
  /** Key prefix inside the bucket, e.g. "prod/". Lets one bucket serve several environments. */
  S3_KEY_PREFIX: z.string().default(''),
  /** Per-object encryption header; `none` relies on the bucket default encryption. */
  S3_SSE: z.enum(['none', 'AES256', 'aws:kms']).default('none'),
  S3_KMS_KEY_ID: z.string().optional(),
  /** Custom endpoint for S3-compatible stores (MinIO, LocalStack); leave unset for AWS. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  /** HMAC key for fs dev URLs; falls back to SESSION_SECRET, and to a fixed dev value outside production. */
  STORAGE_SIGNING_SECRET: z.string().min(16).optional(),
}
export const storageEnvFragment = z.object(storageEnvShape)
export type StorageEnvFragment = z.infer<typeof storageEnvFragment>

export type StorageEnv = Pick<
  Env,
  | 'STORAGE_PROVIDER'
  | 'STORAGE_FS_ROOT'
  | 'S3_BUCKET'
  | 'AWS_REGION'
  | 'PUBLIC_API_URL'
  | 'NODE_ENV'
  | 'SESSION_SECRET'
> &
  Partial<z.input<typeof storageEnvFragment>>

export interface StorageProviderDeps {
  clock?: Clock
  /** Override the S3 client (tests); production relies on the default AWS credential chain. */
  s3Client?: S3Client
}

const DEV_SECRET = 'oasis-dev-storage-signing-key'

export function createStorageProvider(env: StorageEnv, deps: StorageProviderDeps = {}): ObjectStorage {
  const x = storageEnvFragment.parse(env)
  if (env.STORAGE_PROVIDER === 's3') {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_PROVIDER=s3')
    const sse: S3StorageOptions['sse'] =
      x.S3_SSE === 'none'
        ? undefined
        : x.S3_SSE === 'AES256'
          ? { mode: 'AES256' }
          : { mode: 'aws:kms', ...(x.S3_KMS_KEY_ID ? { kmsKeyId: x.S3_KMS_KEY_ID } : {}) }
    return new S3Storage({
      client:
        deps.s3Client ??
        new S3Client({
          region: env.AWS_REGION,
          ...(x.S3_ENDPOINT ? { endpoint: x.S3_ENDPOINT } : {}),
          ...(x.S3_FORCE_PATH_STYLE === 'true' ? { forcePathStyle: true } : {}),
        }),
      bucket: env.S3_BUCKET,
      keyPrefix: x.S3_KEY_PREFIX,
      ...(sse ? { sse } : {}),
    })
  }
  const secret =
    x.STORAGE_SIGNING_SECRET ?? env.SESSION_SECRET ?? (env.NODE_ENV === 'production' ? undefined : DEV_SECRET)
  if (!secret)
    throw new Error(
      'STORAGE_SIGNING_SECRET (or SESSION_SECRET) is required for STORAGE_PROVIDER=fs in production',
    )
  return new FsStorage({
    root: env.STORAGE_FS_ROOT,
    clock: deps.clock ?? systemClock,
    secret,
    baseUrl: `${env.PUBLIC_API_URL.replace(/\/+$/, '')}${DEV_STORAGE_PREFIX}`,
  })
}
