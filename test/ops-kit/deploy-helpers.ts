import { execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const REPO = process.cwd()
export const DEPLOY = path.join(REPO, 'deploy')
export const script = (name: string): string => path.join(DEPLOY, 'scripts', name)

export interface Ran {
  code: number
  stdout: string
  stderr: string
  out: string
}

/** Runs a command without blocking the event loop (tests keep HTTP stubs and databases alive in the same process). */
export function sh(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  input?: string,
  cwd?: string,
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        env: { ...process.env, ...env } as NodeJS.ProcessEnv,
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 240_000,
      },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0
        resolve({ code, stdout, stderr, out: `${stdout}${stderr}` })
      },
    )
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

export function tempDir(prefix = 'oasis-ops-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Every file under a directory with its size and mode, for "nothing changed" comparisons. */
export function tree(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name)
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) continue
      out.push(
        `${path.relative(root, p)} ${st.isDirectory() ? 'dir' : st.size} ${(st.mode & 0o777).toString(8)}`,
      )
      if (st.isDirectory()) walk(p)
    }
  }
  walk(root)
  return out
}

/** An env file the way systemd reads it: NAME=value per line, comments only on their own line, quotes stripped. */
export function parseEnvFile(
  text: string,
  onProblem?: (line: string, why: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) {
      onProblem?.(line, 'not NAME=value')
      continue
    }
    let v = m[2]!
    if (/\s#/.test(v) && !/^['"]/.test(v))
      onProblem?.(line, 'inline comment (systemd keeps it as part of the value)')
    if (/^\S.*\s\S/.test(v) && !/^['"]/.test(v)) onProblem?.(line, 'value with spaces must be quoted')
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
    out[m[1]!] = v
  }
  return out
}

export function names(text: string): Set<string> {
  return new Set([...text.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!))
}

// ---- a small nginx configuration reader ------------------------------------------------------------------------------------------

export interface Directive {
  name: string
  args: string[]
  block?: Directive[]
}

export function parseNginx(text: string): Directive[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (/\s/.test(c)) i++
    else if (c === '#') while (i < text.length && text[i] !== '\n') i++
    else if (c === ';' || c === '{' || c === '}') tokens.push(text[i++]!)
    else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) throw new Error('unterminated string')
      tokens.push(`${c}${text.slice(i + 1, j)}`)
      i = j + 1
    } else {
      let j = i
      while (j < text.length && !/[\s;{}]/.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    }
  }
  let p = 0
  const block = (top: boolean): Directive[] => {
    const out: Directive[] = []
    while (p < tokens.length) {
      const t = tokens[p]!
      if (t === '}') {
        if (top) throw new Error('unexpected }')
        p++
        return out
      }
      const name = tokens[p++]!
      const args: string[] = []
      while (p < tokens.length && !';{}'.includes(tokens[p]!)) args.push(tokens[p++]!.replace(/^["']/, ''))
      const end = tokens[p++]
      if (end === ';') out.push({ name, args })
      else if (end === '{') out.push({ name, args, block: block(false) })
      else throw new Error(`missing ; or { after ${name}`)
    }
    if (!top) throw new Error('missing }')
    return out
  }
  return block(true)
}

export const find = (tree: Directive[], name: string): Directive[] => tree.filter((d) => d.name === name)

/** Resolves include directives by reading the files (relative paths are absolute inside the staged tree). */
export function expandIncludes(tree: Directive[], read: (p: string) => string): Directive[] {
  return tree.flatMap((d) => {
    if (d.name === 'include') return expandIncludes(parseNginx(read(d.args[0]!)), read)
    return d.block ? [{ ...d, block: expandIncludes(d.block, read) }] : [d]
  })
}

export interface Loc {
  modifier: '' | '=' | '^~' | '~' | '~*'
  pattern: string
  body: Directive[]
}

export function locationsOf(server: Directive): Loc[] {
  return find(server.block ?? [], 'location').map((d) => {
    const [a, b] = d.args
    return b === undefined
      ? { modifier: '' as const, pattern: a!, body: d.block ?? [] }
      : { modifier: a as Loc['modifier'], pattern: b, body: d.block ?? [] }
  })
}

/** nginx's location selection: exact match, then the longest prefix (a ^~ prefix wins outright), then the first matching regex, else that prefix. */
export function matchLocation(locs: Loc[], uri: string): Loc | undefined {
  const exact = locs.find((l) => l.modifier === '=' && l.pattern === uri)
  if (exact) return exact
  const prefixes = locs
    .filter((l) => (l.modifier === '' || l.modifier === '^~') && uri.startsWith(l.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)
  const best = prefixes[0]
  if (best?.modifier === '^~') return best
  const regex = locs.find(
    (l) =>
      (l.modifier === '~' || l.modifier === '~*') &&
      new RegExp(l.pattern, l.modifier === '~*' ? 'i' : '').test(uri),
  )
  return regex ?? best
}

export function writeExecutable(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

export const readText = (p: string): string => readFileSync(p, 'utf8')
