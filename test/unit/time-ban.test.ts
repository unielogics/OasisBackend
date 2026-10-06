import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint({ overrideConfigFile: 'eslint.config.js' })
const rules = async (code: string, filePath: string): Promise<string[]> => {
  const [r] = await eslint.lintText(code, { filePath })
  return (r?.messages ?? []).filter((m) => m.ruleId?.startsWith('no-restricted')).map((m) => m.message)
}

describe('time and randomness are injectable (lint rules)', () => {
  const banned: Array<[string, string]> = [
    ['Date.now()', 'export const t = Date.now()'],
    ['new Date()', 'export const t = new Date()'],
    ['Date()', 'export const t = Date()'],
    ['Math.random()', 'export const r = Math.random()'],
    ['Luxon DateTime.now()', "import { DateTime } from 'luxon'\nexport const t = DateTime.now()"],
    ['Luxon DateTime.local()', "import { DateTime } from 'luxon'\nexport const t = DateTime.local()"],
    ['Luxon DateTime.utc()', "import { DateTime } from 'luxon'\nexport const t = DateTime.utc()"],
  ]
  it.each(banned)('rejects %s in a module', async (_name, code) => {
    expect(await rules(code, 'src/modules/example/service.ts')).not.toEqual([])
    expect(await rules(code, 'src/http/routes/example.ts')).not.toEqual([])
    expect(await rules(code, 'db/seeds/example.ts')).not.toEqual([])
  })

  it.each(banned)(
    'allows %s only in the platform clock/time/random modules, tests and scripts',
    async (_name, code) => {
      for (const f of [
        'src/platform/clock.ts',
        'src/platform/time.ts',
        'src/platform/random.ts',
        'test/unit/x.test.ts',
        'scripts/x.ts',
      ]) {
        expect(await rules(code, f)).toEqual([])
      }
    },
  )

  it('allows deterministic uses', async () => {
    const code =
      "import { DateTime } from 'luxon'\nexport const a = new Date(0), b = new Date('2026-01-01'), c = DateTime.local(2026, 1, 1), d = DateTime.fromISO('2026-01-01')"
    expect(await rules(code, 'src/modules/example/service.ts')).toEqual([])
  })
})

const stripComments = (text: string, kind: 'sql' | 'ts'): string =>
  kind === 'sql'
    ? text.replace(/--.*$/gm, '')
    : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, ext, out)
    else if (full.endsWith(ext)) out.push(full)
  }
  return out
}

const SQL_CLOCK =
  /(?<![.\w])(now\s*\(\s*\)|current_timestamp|localtimestamp|current_date|current_time\b|statement_timestamp\s*\(|transaction_timestamp\s*\(|clock_timestamp\s*\()/i

describe('SQL never reads the wall clock directly (use app_now())', () => {
  it('the detector flags wall-clock reads and ignores app_now() and Clock.now()', () => {
    for (const bad of [
      'default now()',
      'select NOW ( )',
      'created_at timestamptz default current_timestamp',
      'select clock_timestamp()',
      'where d = current_date',
    ]) {
      expect(SQL_CLOCK.test(bad), bad).toBe(true)
    }
    for (const ok of ['default app_now()', 'clock.now()', 'select app_now()', 'this.now()'])
      expect(SQL_CLOCK.test(ok), ok).toBe(false)
  })

  it('migrations only call clock_timestamp() inside app_now()', () => {
    for (const file of walk('db/migrations', '.sql')) {
      const sql = stripComments(readFileSync(file, 'utf8'), 'sql')
      const without = sql.replace(/create function app_now\(\)[\s\S]*?\$\$;?[\s\S]*?\$\$/i, '')
      expect(SQL_CLOCK.exec(without)?.[0] ?? null, file).toBeNull()
    }
  })

  it('application SQL fragments and seeds do not read the wall clock', () => {
    const literal = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g
    const looksLikeSql = /\b(select|insert|update|delete|from|where|default|set_config)\b/i
    for (const file of [...walk('src', '.ts'), ...walk('db/seeds', '.ts')]) {
      const ts = stripComments(readFileSync(file, 'utf8'), 'ts')
      for (const lit of ts.match(literal) ?? []) {
        if (looksLikeSql.test(lit))
          expect(SQL_CLOCK.exec(lit)?.[0] ?? null, `${file}: ${lit.slice(0, 60)}`).toBeNull()
      }
    }
  })
})
