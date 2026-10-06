// RFC 4180 CSV: UTF-8 BOM, CRLF line ends, quoting where required, spreadsheet formula-injection guard.
export const CSV_BOM = '﻿'
const EOL = '\r\n'

/**
 * text: user-controlled strings; a leading = + - @ (or tab / carriage return) is neutralised with a leading apostrophe.
 * number: pre-formatted numeric strings or numbers (money decimals, counts); never prefixed, so "-2.50" stays numeric.
 */
export type CsvKind = 'text' | 'number'

export interface CsvColumn<Row> {
  header: string
  kind?: CsvKind
  value: (row: Row) => string | number | boolean | null | undefined
}

const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: string | number | boolean | null | undefined, kind: CsvKind = 'text'): string {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'string' ? value : String(value)
  if (kind === 'text' && typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csvLine(cells: readonly string[]): string {
  return cells.join(',') + EOL
}

export function* csvChunks<Row>(
  columns: readonly CsvColumn<Row>[],
  rows: Iterable<Row>,
  withBom = true,
): Generator<string> {
  if (withBom) yield CSV_BOM
  yield csvLine(columns.map((c) => csvCell(c.header, 'text')))
  for (const row of rows) yield csvLine(columns.map((c) => csvCell(c.value(row), c.kind ?? 'text')))
}

export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: Iterable<Row>, withBom = true): string {
  let out = ''
  for (const chunk of csvChunks(columns, rows, withBom)) out += chunk
  return out
}
