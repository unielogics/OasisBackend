import { S3Client } from '@aws-sdk/client-s3'
import type { z } from 'zod'
import type { Env } from '../../config/env.js'
import { systemClock, type Clock } from '../../platform/clock.js'
import { DEV_STORAGE_PREFIX, FsStorage } from './fs-provider.js'
import { S3Storage, type S3StorageOptions } from './s3-provider.js'
import { storageEnvFragment } from './env.js'
import type { ObjectStorage } from './types.js'

export { storageEnvShape, storageEnvFragment, type StorageEnvFragment } from './env.js'

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
