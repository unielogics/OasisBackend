// Parses the pg_dump snapshot (db/schema.sql) into tables, columns, constraints and indexes, and renders the markdown reference.
export interface Column {
  name: string
  type: string
  notNull: boolean
  default: string | null
}

export interface ForeignKey {
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: string | null
}

export interface Table {
  name: string
  columns: Column[]
  primaryKey: string[]
  uniques: string[][]
  foreignKeys: ForeignKey[]
  checks: number
  indexes: { name: string; unique: boolean; method: string; columns: string; where: string | null }[]
  triggers: string[]
}

export interface Schema {
  tables: Table[]
  views: string[]
  functions: { name: string; signature: string }[]
  extensions: string[]
}

const cols = (s: string): string[] => s.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
const strip = (s: string): string => s.replace(/^public\./, '')

function parseColumn(line: string): Column | null {
  const m = /^ {4}("?[a-z_][a-z0-9_]*"?) (.+?),?$/.exec(line)
  if (!m || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/.test(m[1]!)) return null
  let rest = m[2]!
  const notNull = / NOT NULL$/.test(rest)
  rest = rest.replace(/ NOT NULL$/, '')
  let def: string | null = null
  const d = rest.indexOf(' DEFAULT ')
  if (d >= 0) {
    def = rest.slice(d + ' DEFAULT '.length).replaceAll('public.', '')
    rest = rest.slice(0, d)
  }
  return { name: m[1]!.replace(/"/g, ''), type: rest.replaceAll('public.', ''), notNull, default: def }
}

export function parseSchema(sqlText: string): Schema {
  const tables = new Map<string, Table>()
  const lines = sqlText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^CREATE TABLE public\.("?[a-z_][a-z0-9_]*"?) \($/.exec(lines[i]!)
    if (!m) continue
    const t: Table = {
      name: m[1]!.replace(/"/g, ''),
      columns: [],
      primaryKey: [],
      uniques: [],
      foreignKeys: [],
      checks: 0,
      indexes: [],
      triggers: [],
    }
    for (i++; i < lines.length && lines[i] !== ');'; i++) {
      const line = lines[i]!
      if (/^ {4}CONSTRAINT .* CHECK /.test(line)) t.checks++
      else {
        const c = parseColumn(line)
        if (c) t.columns.push(c)
      }
    }
    tables.set(t.name, t)
  }
  // "ALTER TABLE ONLY public.t\n    ADD CONSTRAINT name KIND (...)"
  for (let i = 0; i < lines.length; i++) {
    const a = /^ALTER TABLE ONLY public\.("?[a-z_][a-z0-9_]*"?)$/.exec(lines[i]!)
    if (!a) continue
    const t = tables.get(a[1]!.replace(/"/g, ''))
    const c = lines[i + 1]
    if (!t || !c) continue
    let m = /ADD CONSTRAINT \S+ PRIMARY KEY \((.+)\);/.exec(c)
    if (m) t.primaryKey = cols(m[1]!)
    m = /ADD CONSTRAINT \S+ UNIQUE \((.+)\);/.exec(c)
    if (m) t.uniques.push(cols(m[1]!))
    m =
      /ADD CONSTRAINT \S+ FOREIGN KEY \((.+?)\) REFERENCES public\.(\S+?)\((.+?)\)(?: ON DELETE ((?:SET NULL|SET DEFAULT|CASCADE|RESTRICT|NO ACTION)))?/.exec(
        c,
      )
    if (m)
      t.foreignKeys.push({
        columns: cols(m[1]!),
        refTable: m[2]!,
        refColumns: cols(m[3]!),
        onDelete: m[4] ?? null,
      })
  }
  for (const line of lines) {
    const m = /^CREATE (UNIQUE )?INDEX (\S+) ON public\.(\S+) USING (\w+) \((.+?)\)(?: WHERE (.+))?;$/.exec(
      line,
    )
    if (m)
      tables
        .get(m[3]!)
        ?.indexes.push({
          name: m[2]!,
          unique: Boolean(m[1]),
          method: m[4]!,
          columns: m[5]!,
          where: m[6] ?? null,
        })
    const tr = /^CREATE TRIGGER (\S+) .* ON public\.(\S+) FOR EACH/.exec(line)
    if (tr) tables.get(tr[2]!)?.triggers.push(tr[1]!)
  }
  const views = lines.flatMap((l) => {
    const m = /^CREATE VIEW public\.(\S+) AS$/.exec(l)
    return m ? [m[1]!] : []
  })
  const functions = lines.flatMap((l) => {
    const m = /^CREATE FUNCTION public\.(\w+)\((.*?)\) RETURNS (.+)$/.exec(l)
    return m
      ? [
          {
            name: m[1]!,
            signature: `${m[1]!}(${m[2]!.replaceAll('public.', '')}) returns ${m[3]!.replace(/ LANGUAGE.*$/, '').replaceAll('public.', '')}`,
          },
        ]
      : []
  })
  const extensions = lines.flatMap((l) => {
    const m = /^CREATE EXTENSION IF NOT EXISTS (\w+)/.exec(l)
    return m ? [m[1]!] : []
  })
  return {
    tables: [...tables.values()].sort((x, y) => x.name.localeCompare(y.name)),
    views,
    functions: functions.sort((x, y) => x.name.localeCompare(y.name)),
    extensions,
  }
}

const cell = (s: string): string => s.replaceAll('|', '\\|').replaceAll('\n', ' ')

export function renderReference(s: Schema): string {
  const out: string[] = []
  out.push(
    `Generated from \`db/schema.sql\` by \`pnpm data-model\` (${s.tables.length} tables, ${s.views.length} view${s.views.length === 1 ? '' : 's'}, ${s.functions.length} functions). Do not edit by hand: change a migration, run \`pnpm db:schema\` then \`pnpm data-model\`.`,
  )
  out.push('')
  for (const t of s.tables) {
    out.push(`#### \`${t.name}\``, '')
    out.push('| Column | Type | Null | Default |', '| --- | --- | --- | --- |')
    for (const c of t.columns)
      out.push(
        `| \`${c.name}\` | ${cell(c.type)} | ${c.notNull ? 'no' : 'yes'} | ${c.default ? `\`${cell(c.default)}\`` : ''} |`,
      )
    out.push('')
    const facts: string[] = []
    if (t.primaryKey.length) facts.push(`Primary key \`(${t.primaryKey.join(', ')})\`.`)
    for (const u of t.uniques) facts.push(`Unique \`(${u.join(', ')})\`.`)
    for (const f of t.foreignKeys)
      facts.push(
        `\`(${f.columns.join(', ')})\` references \`${f.refTable}(${f.refColumns.join(', ')})\`${f.onDelete ? ` on delete ${f.onDelete.toLowerCase()}` : ''}.`,
      )
    if (t.checks) facts.push(`${t.checks} check constraint${t.checks === 1 ? '' : 's'}.`)
    for (const x of t.indexes)
      facts.push(
        `${x.unique ? 'Unique index' : 'Index'} \`${x.name}\` \`(${x.columns})\`${x.where ? ` where \`${x.where.replace(/^\((.*)\)$/, '$1')}\`` : ''}.`,
      )
    if (t.triggers.length)
      facts.push(
        `Trigger${t.triggers.length === 1 ? '' : 's'}: ${t.triggers.map((x) => `\`${x}\``).join(', ')}.`,
      )
    if (facts.length) out.push(facts.join(' '), '')
  }
  out.push('#### Views and functions', '')
  for (const v of s.views) out.push(`- view \`${v}\``)
  for (const f of s.functions) out.push(`- function \`${f.signature}\``)
  out.push('')
  return out.join('\n').trimEnd()
}
