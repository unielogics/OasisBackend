// Every environment key the application reads must be declared in src/config/env.ts: zod drops undeclared keys, so a
// config module that reads one from the parsed Env silently gets undefined (S3_KEY_PREFIX and friends were dropped this way),
// and one that reads process.env directly bypasses validation and the deploy templates.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { envSchema } from '../../src/config/env.js'

const SRC = path.resolve('src')
const declared = new Set(
  Object.keys((envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema.shape),
)

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [],
  )
}

/** Environment keys a source file reads: process.env.X, process.env['X'], env.X / e.X / x.X / source.X, and the keys of zod
 * objects in config modules (files named config.ts or env.ts). Only SCREAMING_SNAKE names count. */
export function keysRead(file: string, text: string): string[] {
  const found = new Set<string>()
  const add = (re: RegExp): void => {
    for (const m of text.matchAll(re)) found.add(m[1]!)
  }
  add(/process\.env\.([A-Z][A-Z0-9_]{2,})\b/g)
  add(/process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g)
  add(/\b(?:env|e|x|source)\.([A-Z][A-Z0-9_]{2,})\b/g)
  if (/(?:^|\/)(?:config|env)\.ts$/.test(file)) add(/^\s+([A-Z][A-Z0-9_]{2,}):\s/gm)
  return [...found]
}

describe('environment contract coverage', () => {
  it('finds keys the way the application reads them (the scanner itself)', () => {
    const sample = [
      "const a = process.env.SOME_NEW_KEY",
      "const b = process.env['OTHER_KEY']",
      'const c = env.S3_KEY_PREFIX + e.FOO_BAR',
      'const shape = {',
      '  NEW_SETTING: z.string(),',
      '}',
    ].join('\n')
    expect(keysRead('src/integrations/demo/config.ts', sample).sort()).toEqual(
      ['FOO_BAR', 'NEW_SETTING', 'OTHER_KEY', 'S3_KEY_PREFIX', 'SOME_NEW_KEY'].sort(),
    )
    expect(keysRead('src/modules/demo/service.ts', '  NEW_SETTING: z.string(),')).toEqual([])
  })

  it('every key a module or config reads is declared in src/config/env.ts', () => {
    const missing: string[] = []
    for (const f of files(SRC)) {
      const rel = path.relative(process.cwd(), f)
      if (rel === path.join('src', 'config', 'env.ts')) continue
      for (const k of keysRead(rel, readFileSync(f, 'utf8'))) if (!declared.has(k)) missing.push(`${rel}: ${k}`)
    }
    expect(missing).toEqual([])
  })

  it('declares the AWS integration settings the docs promise', () => {
    for (const k of [
      'S3_KEY_PREFIX',
      'S3_SSE',
      'S3_KMS_KEY_ID',
      'S3_ENDPOINT',
      'S3_FORCE_PATH_STYLE',
      'STORAGE_SIGNING_SECRET',
      'SES_SNS_TOPIC_ARNS',
      'SES_ENDPOINT',
      'SES_FROM_NAME',
      'SES_REPLY_TO',
      'SES_CONFIGURATION_SET',
    ])
      expect(declared.has(k), k).toBe(true)
  })
})
