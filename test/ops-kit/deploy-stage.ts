import { beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { script, sh, tempDir } from './deploy-helpers.js'

export interface Stage {
  root: string
  etc: string
  nginx: string
  systemd: string
  prefix: string
  env: Record<string, string>
  cert: string
  key: string
}

/** Runs install.sh into a throwaway root (no system changes) once per test file. */
export function useStage(extra: string[] = []): Stage {
  const tmp = tempDir('oasis-stage-')
  const stage = {} as Stage
  beforeAll(async () => {
    const root = tmp.dir
    Object.assign(stage, {
      root,
      etc: path.join(root, 'etc/oasis'),
      nginx: path.join(root, 'etc/nginx'),
      systemd: path.join(root, 'etc/systemd/system'),
      prefix: path.join(root, 'opt/oasis'),
      env: { OASIS_ROOT_PREFIX: root },
      cert: '/etc/ssl/oasis/fullchain.pem',
      key: '/etc/ssl/oasis/privkey.pem',
    })
    const r = await sh(
      script('install.sh'),
      [
        '--domain',
        'oasis.example.com',
        '--tls',
        'files',
        '--tls-cert',
        stage.cert,
        '--tls-key',
        stage.key,
        '--no-system',
        ...extra,
      ],
      stage.env,
    )
    if (r.code !== 0) throw new Error(`install.sh failed:\n${r.out}`)
  }, 120_000)
  afterAll(() => tmp.cleanup())
  return stage
}
