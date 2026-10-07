// deploy.sh and rollback.sh end to end against real git repositories, with pnpm, systemctl, the health check and the backup replaced by
// recording stand-ins. Everything else (git fetch/archive, release directories, symlink switching, locking, pruning) is the real code.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { script, sh, tempDir, tree, writeExecutable } from './deploy-helpers.js'

interface World {
  root: string
  prefix: string
  state: string
  env: Record<string, string>
  commit(repo: 'backend' | 'dashboard', files: Record<string, string>): Promise<string>
  deploy(...args: string[]): ReturnType<typeof sh>
  rollback(...args: string[]): ReturnType<typeof sh>
  log(): string[]
  clearLog(): void
  releases(): string[]
  current(): string
  previous(): string | undefined
  flag(name: string, on?: boolean): void
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const git = (cwd: string, ...args: string[]) =>
  sh(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    {},
    undefined,
    cwd,
  )

async function makeWorld(): Promise<World> {
  const t = tempDir('oasis-flow-')
  cleanups.push(t.cleanup)
  const root = t.dir
  const env0 = { OASIS_ROOT_PREFIX: root }
  const inst = await sh(
    script('install.sh'),
    [
      '--domain',
      'oasis.example.com',
      '--tls',
      'files',
      '--tls-cert',
      '/c.pem',
      '--tls-key',
      '/k.pem',
      '--no-system',
    ],
    env0,
  )
  if (inst.code !== 0) throw new Error(inst.out)
  const prefix = path.join(root, 'opt/oasis')
  const state = path.join(root, 'shim-state')
  mkdirSync(state, { recursive: true })
  const bin = path.join(root, 'shims')
  const logFile = path.join(state, 'calls.log')
  writeFileSync(logFile, '')

  writeExecutable(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env bash
echo "pnpm $(basename "$PWD") $*" >> "$SHIM_LOG"
case "$*" in
  "install --frozen-lockfile") ;;
  "build") [ -e FAIL_BUILD ] && { echo "build broke" >&2; exit 1; }; mkdir -p dist; echo '//' > dist/server.js; echo '//' > dist/worker.js ;;
  "build:live") mkdir -p .next-live; echo x > .next-live/BUILD_ID ;;
  "migrate up") echo "migrate DATABASE_URL=\${DATABASE_URL:+set} SECRETS_KEY=\${SECRETS_KEY:+set}" >> "$SHIM_LOG"; [ -e FAIL_MIGRATE ] && { echo "migration broke" >&2; exit 1; }; echo "$PWD" >> "$SHIM_STATE/migrated-by" ;;
  *) echo "unexpected pnpm $*" >&2; exit 1 ;;
esac
`,
  )
  writeExecutable(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
echo "systemctl $*" >> "$SHIM_LOG"
[ "$1" = restart ] && [ -e "$SHIM_STATE/fail-restart-$2" ] && { echo "Job failed" >&2; exit 1; }
exit 0
`,
  )
  writeExecutable(
    path.join(bin, 'health.sh'),
    `#!/usr/bin/env bash
echo "health $* current=$(basename "$(readlink -f "$OASIS_PREFIX/current")")" >> "$SHIM_LOG"
[ -e "$OASIS_PREFIX/current/backend/BAD" ] && { echo "UNHEALTHY (stand-in)" >&2; exit 1; }
[ -e "$SHIM_STATE/unhealthy-now" ] && { echo "UNHEALTHY (stand-in, flag)" >&2; exit 1; }
exit 0
`,
  )
  writeExecutable(
    path.join(bin, 'backup.sh'),
    `#!/usr/bin/env bash
echo "backup $*" >> "$SHIM_LOG"
[ -e "$SHIM_STATE/fail-backup" ] && { echo "backup broke" >&2; exit 1; }
exit 0
`,
  )

  const origin = (repo: string) => path.join(root, 'origin', repo)
  for (const repo of ['backend', 'dashboard']) {
    mkdirSync(origin(repo), { recursive: true })
    await git(origin(repo), 'init', '-q', '-b', 'main')
    writeFileSync(path.join(origin(repo), 'package.json'), `{"name":"fake-${repo}"}\n`)
    writeFileSync(path.join(origin(repo), 'VERSION'), 'v1\n')
    await git(origin(repo), 'add', '-A')
    await git(origin(repo), 'commit', '-q', '-m', 'v1')
    const clone = await git(root, 'clone', '-q', origin(repo), path.join(prefix, 'src', repo))
    if (clone.code !== 0) throw new Error(clone.out)
  }

  const env = {
    ...env0,
    OASIS_ALLOW_NONROOT: '1',
    OASIS_RUN_AS: '',
    SYSTEMCTL: path.join(bin, 'systemctl'),
    HEALTH_CMD: path.join(bin, 'health.sh'),
    BACKUP_CMD: path.join(bin, 'backup.sh'),
    PATH: `${bin}:${process.env.PATH}`,
    SHIM_LOG: logFile,
    SHIM_STATE: state,
    OASIS_PREFIX: prefix,
  }
  const releasesDir = path.join(prefix, 'releases')
  return {
    root,
    prefix,
    state,
    env,
    async commit(repo, files) {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(origin(repo), f)), { recursive: true })
        if (body === '__delete__') rmSync(path.join(origin(repo), f), { force: true })
        else writeFileSync(path.join(origin(repo), f), body)
      }
      await git(origin(repo), 'add', '-A')
      await git(origin(repo), 'commit', '-q', '-m', `change ${Object.keys(files).join(',')}`)
      return (await git(origin(repo), 'rev-parse', 'HEAD')).stdout.trim()
    },
    deploy: (...args) => sh(script('deploy.sh'), args, env),
    rollback: (...args) => sh(script('rollback.sh'), args, env),
    log: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
    clearLog: () => writeFileSync(logFile, ''),
    releases: () => (existsSync(releasesDir) ? readdirSync(releasesDir).sort() : []),
    current: () => path.basename(realpathSync(path.join(prefix, 'current'))),
    previous: () =>
      existsSync(path.join(prefix, 'previous'))
        ? path.basename(realpathSync(path.join(prefix, 'previous')))
        : undefined,
    flag(name, on = true) {
      const f = path.join(state, name)
      if (on) writeFileSync(f, '')
      else rmSync(f, { force: true })
    },
  }
}

const calls = (w: World, prefix: string): string[] => w.log().filter((l) => l.startsWith(prefix))

describe('deploy.sh', () => {
  it('first deployment: exports both trees, builds, backs up, migrates with the new code, switches, restarts in order, and checks health', async () => {
    const w = await makeWorld()
    const r = await w.deploy()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/release \S+ is live/)

    const rel = path.join(w.prefix, 'releases', w.current())
    expect(readdirSync(w.releases().length ? path.join(w.prefix, 'releases') : w.prefix)).toHaveLength(1)
    expect(existsSync(path.join(rel, 'backend/dist/server.js'))).toBe(true)
    expect(existsSync(path.join(rel, 'dashboard/.next-live/BUILD_ID'))).toBe(true)
    expect(existsSync(path.join(rel, 'backend/.git'))).toBe(false) // an export, not a clone
    const revisions = readFileSync(path.join(rel, 'REVISIONS'), 'utf8')
    const sha = (repo: string) =>
      sh('git', ['rev-parse', 'origin/main'], {}, undefined, path.join(w.prefix, 'src', repo))
    expect(revisions).toContain(`backend=${(await sha('backend')).stdout.trim()}`)
    expect(revisions).toContain(`dashboard=${(await sha('dashboard')).stdout.trim()}`)
    expect(w.previous()).toBeUndefined()

    // order: build both, back up, migrate, restart worker -> api -> web, then check health
    const order = w.log().map((l) => l.replace(/ current=.*/, '').replace(/^migrate .*/, 'migrate'))
    expect(order).toEqual([
      'pnpm backend install --frozen-lockfile',
      'pnpm backend build',
      'pnpm dashboard install --frozen-lockfile',
      'pnpm dashboard build:live',
      'backup --label pre-deploy',
      'pnpm backend migrate up',
      'migrate',
      'systemctl restart oasis-worker.service',
      'systemctl restart oasis-api.service',
      'systemctl restart oasis-web.service',
      'health --wait 90',
    ])
    // the migration ran in the NEW release, with the environment files loaded
    expect(calls(w, 'migrate ')[0]).toBe('migrate DATABASE_URL=set SECRETS_KEY=set')
    expect(readFileSync(path.join(w.state, 'migrated-by'), 'utf8').trim()).toBe(path.join(rel, 'backend'))
    // and health was judged against the new release
    expect(calls(w, 'health')[0]).toContain(`current=${w.current()}`)
    expect(readFileSync(path.join(w.root, 'var/log/oasis/deploys.list'), 'utf8')).toMatch(/ ok\n$/)
  }, 60_000)

  it('does nothing when the current release already has the latest commits, and --force rebuilds', async () => {
    const w = await makeWorld()
    expect((await w.deploy()).code).toBe(0)
    const first = w.current()
    w.clearLog()
    const again = await w.deploy()
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/nothing to deploy/)
    expect(w.log()).toEqual([])
    expect(w.current()).toBe(first)
    const forced = await w.deploy('--force')
    expect(forced.code, forced.out).toBe(0)
    expect(w.current()).not.toBe(first) // same commits, new build id (the second differs by timestamp)
  }, 60_000)

  it('a new commit becomes a new release; the old one is kept as previous', async () => {
    const w = await makeWorld()
    await w.deploy()
    const first = w.current()
    await w.commit('backend', { VERSION: 'v2\n' })
    const r = await w.deploy()
    expect(r.code, r.out).toBe(0)
    expect(w.current()).not.toBe(first)
    expect(w.previous()).toBe(first)
    expect(readFileSync(path.join(w.prefix, 'releases', w.current(), 'backend/VERSION'), 'utf8')).toBe('v2\n')
    expect(readFileSync(path.join(w.prefix, 'releases', first, 'backend/VERSION'), 'utf8')).toBe('v1\n')
  }, 60_000)

  it('rolls back by itself when the new release is not healthy, and keeps the failed build for inspection', async () => {
    const w = await makeWorld()
    await w.deploy()
    const good = w.current()
    await w.commit('backend', { BAD: 'x\n' })
    w.clearLog()
    const r = await w.deploy()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/not healthy: rolling back/)
    expect(r.out).toMatch(/rolled back to .* it is healthy again/)
    expect(w.current()).toBe(good)
    expect(w.releases().some((n) => n.endsWith('.failed'))).toBe(true)
    // restarted for the bad release, then again for the rollback, and health checked after each
    expect(calls(w, 'systemctl restart')).toHaveLength(6)
    expect(calls(w, 'health').map((l) => l.replace(/^.*current=/, ''))).toEqual([
      expect.stringMatching(/-b/),
      good,
    ])
    expect(readFileSync(path.join(w.root, 'var/log/oasis/deploys.list'), 'utf8')).toMatch(/rolled-back/)
  }, 60_000)

  it('rolls back when a service fails to restart', async () => {
    const w = await makeWorld()
    await w.deploy()
    const good = w.current()
    await w.commit('dashboard', { VERSION: 'v2\n' })
    w.flag('fail-restart-oasis-api.service')
    const r = await w.deploy()
    expect(r.code).toBe(1)
    // the failing restart is also what the rollback hits, so it must not claim success
    expect(w.current()).toBe(good)
    expect(r.out).toMatch(/rolling back/)
  }, 60_000)

  it('first deployment that is unhealthy leaves nothing running and no current release', async () => {
    const w = await makeWorld()
    await w.commit('backend', { BAD: 'x\n' })
    const r = await w.deploy()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no previous release to go back to/)
    expect(existsSync(path.join(w.prefix, 'current'))).toBe(false) // it was switched, then moved aside with the failed release
    expect(calls(w, 'systemctl stop').length).toBe(3)
  }, 60_000)

  it('a failed build changes nothing that runs: no migration, no switch, no restart', async () => {
    const w = await makeWorld()
    await w.deploy()
    const good = w.current()
    await w.commit('backend', { FAIL_BUILD: '1\n' })
    w.clearLog()
    const r = await w.deploy()
    expect(r.code).not.toBe(0)
    expect(w.current()).toBe(good)
    expect(calls(w, 'migrate')).toEqual([])
    expect(calls(w, 'systemctl')).toEqual([])
    expect(calls(w, 'backup')).toEqual([])
    expect(w.releases().some((n) => n.endsWith('.failed'))).toBe(true)
    expect(w.releases().some((n) => n.endsWith('.partial'))).toBe(false)
  }, 60_000)

  it('a failed migration changes nothing that runs: the old release keeps serving', async () => {
    const w = await makeWorld()
    await w.deploy()
    const good = w.current()
    await w.commit('backend', { FAIL_MIGRATE: '1\n' })
    w.clearLog()
    const r = await w.deploy()
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/migration failed; the running release was not touched/)
    expect(w.current()).toBe(good)
    expect(calls(w, 'systemctl')).toEqual([])
    expect(calls(w, 'backup')).toEqual(['backup --label pre-deploy']) // the safety net was taken before the attempt
  }, 60_000)

  it('a failed pre-deploy backup stops the deploy before any migration, unless --skip-backup is given', async () => {
    const w = await makeWorld()
    w.flag('fail-backup')
    const r = await w.deploy()
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/the pre-deploy backup failed; nothing was changed/)
    expect(calls(w, 'migrate')).toEqual([])
    expect(existsSync(path.join(w.prefix, 'current'))).toBe(false)
    const skipped = await w.deploy('--skip-backup')
    expect(skipped.code, skipped.out).toBe(0)
    expect(skipped.out).toMatch(/skipping the pre-deploy backup/)
  }, 60_000)

  it('keeps the newest releases, always the current and previous one, and at most two failed builds', async () => {
    const w = await makeWorld()
    for (let i = 2; i <= 5; i++) {
      await w.commit('backend', { VERSION: `v${i}\n` })
      expect((await w.deploy('--keep', '2')).code).toBe(0)
    }
    const kept = w.releases().filter((n) => !n.endsWith('.failed'))
    expect(kept).toHaveLength(2)
    expect(kept).toContain(w.current())
    expect(kept).toContain(w.previous()!)
  }, 90_000)

  it('refuses to run twice at once', async () => {
    const w = await makeWorld()
    const holder = spawn('flock', ['-x', path.join(w.prefix, '.deploy.lock'), 'sleep', '8'])
    await new Promise((r) => setTimeout(r, 400))
    try {
      const r = await w.deploy()
      expect(r.code).not.toBe(0)
      expect(r.out).toMatch(/another deploy or rollback is running/)
      expect(w.log()).toEqual([])
    } finally {
      holder.kill()
    }
  }, 30_000)

  it('--dry-run prints the plan and changes nothing', async () => {
    const w = await makeWorld()
    const before = tree(w.root).filter(
      (l) => !l.startsWith('opt/oasis/.deploy.lock') && !l.startsWith('opt/oasis/src/'),
    )
    const r = await w.deploy('--dry-run')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/would export backend/)
    expect(r.out).toMatch(/\+ ln -sfn/)
    expect(w.log()).toEqual([])
    const after = tree(w.root).filter(
      (l) => !l.startsWith('opt/oasis/.deploy.lock') && !l.startsWith('opt/oasis/src/'),
    )
    expect(after).toEqual(before)
  }, 30_000)

  it('says so when a release changes the deployment configuration (units, nginx, env templates), and stays quiet otherwise', async () => {
    const w = await makeWorld()
    await w.commit('backend', { 'deploy/systemd/oasis-api.service': '[Service]\nUser=oasis\n' })
    expect((await w.deploy()).code).toBe(0)
    await w.commit('backend', {
      'deploy/systemd/oasis-api.service': '[Service]\nUser=oasis\nRestart=always\n',
    })
    const changed = await w.deploy()
    expect(changed.code, changed.out).toBe(0)
    expect(changed.out).toMatch(
      /this release changes the deployment configuration; apply it with install\.sh/,
    )
    expect(changed.out).toMatch(/oasis-api\.service differ/)
    await w.commit('backend', { VERSION: 'v3\n' })
    expect((await w.deploy()).out).not.toMatch(/changes the deployment configuration/)
  }, 60_000)

  it('does its git, build, backup and migration work as the service user, and only the switch and the restarts as the caller', async () => {
    const w = await makeWorld()
    const runas = path.join(w.root, 'shims/runas')
    writeExecutable(runas, `#!/usr/bin/env bash\necho "runas $*" >> "$SHIM_LOG"\nexec "$@"\n`)
    const r = await sh(script('deploy.sh'), [], { ...w.env, OASIS_RUN_AS: runas })
    expect(r.code, r.out).toBe(0)
    const log = w.log()
    const asService = log.filter((l) => l.startsWith('runas ')).map((l) => l.replace(/^runas /, ''))
    expect(asService.some((l) => l.startsWith('git -C') && l.includes('fetch'))).toBe(true)
    expect(asService.some((l) => l.startsWith('git -C') && l.includes('rev-parse'))).toBe(true)
    expect(asService.some((l) => l.startsWith('git -C') && l.includes('archive'))).toBe(true)
    expect(asService.some((l) => l.startsWith('tar -x'))).toBe(true)
    expect(asService.filter((l) => l.startsWith('env')).length).toBeGreaterThanOrEqual(3) // two builds and the migration
    expect(log.some((l) => l.startsWith('runas') && l.includes('backup.sh'))).toBe(true)
    expect(log.filter((l) => l.startsWith('runas') && l.includes('systemctl'))).toEqual([])
    expect(calls(w, 'systemctl restart')).toHaveLength(3)
  }, 60_000)

  it('refuses to start without the repositories or the environment files', async () => {
    const w = await makeWorld()
    rmSync(path.join(w.prefix, 'src/dashboard'), { recursive: true })
    expect((await w.deploy()).out).toMatch(/src\/dashboard is not a git clone/)
    const w2 = await makeWorld()
    rmSync(path.join(w2.root, 'etc/oasis/common.env'))
    expect((await w2.deploy()).out).toMatch(/common\.env is missing/)
  }, 30_000)
})

describe('rollback.sh', () => {
  async function twoReleases(): Promise<{ w: World; first: string; second: string }> {
    const w = await makeWorld()
    await w.deploy()
    const first = w.current()
    await w.commit('backend', { VERSION: 'v2\n' })
    await w.deploy()
    return { w, first, second: w.current() }
  }

  it('goes back to the previous release without a rebuild, swaps the pointers and restarts the services', async () => {
    const { w, first, second } = await twoReleases()
    w.clearLog()
    const r = await w.rollback()
    expect(r.code, r.out).toBe(0)
    expect(w.current()).toBe(first)
    expect(w.previous()).toBe(second)
    expect(w.log().map((l) => l.replace(/ current=.*/, ''))).toEqual([
      'systemctl restart oasis-worker.service',
      'systemctl restart oasis-api.service',
      'systemctl restart oasis-web.service',
      'health --wait 90',
    ])
    // rolling forward again is the same command
    expect((await w.rollback()).code).toBe(0)
    expect(w.current()).toBe(second)
  }, 60_000)

  it('--list shows the releases with current and previous marked, and --to picks one', async () => {
    const { w, first, second } = await twoReleases()
    const list = await w.rollback('--list')
    expect(list.out).toContain(`${second} <- current`)
    expect(list.out).toContain(`${first} <- previous`)
    expect((await w.rollback('--to', first)).code).toBe(0)
    expect(w.current()).toBe(first)
    expect((await w.rollback('--to', first)).out).toMatch(/already the current release/)
  }, 60_000)

  it('refuses an incomplete release and a missing one', async () => {
    const { w, first } = await twoReleases()
    rmSync(path.join(w.prefix, 'releases', first, 'backend/dist'), { recursive: true })
    const r = await w.rollback()
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/is not a complete build/)
    expect((await w.rollback('--to', 'does-not-exist')).out).toMatch(/no release to go back to/)
  }, 60_000)

  it('exits 3 and says so when the release it switched to is not healthy', async () => {
    const { w, first } = await twoReleases()
    w.flag('unhealthy-now')
    const r = await w.rollback()
    expect(r.code).toBe(3)
    expect(r.out).toMatch(/switched to .* but the stack is not healthy/)
    expect(w.current()).toBe(first) // it does not flip back by itself: the operator decides
  }, 60_000)

  it('refuses to run while a deploy holds the lock', async () => {
    const { w } = await twoReleases()
    const holder = spawn('flock', ['-x', path.join(w.prefix, '.deploy.lock'), 'sleep', '6'])
    await new Promise((r) => setTimeout(r, 400))
    try {
      expect((await w.rollback()).out).toMatch(/a deploy or rollback is running/)
    } finally {
      holder.kill()
    }
  }, 60_000)
})
