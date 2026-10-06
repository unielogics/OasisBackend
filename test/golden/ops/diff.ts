// Flattens two JSON values and lists the paths where they differ, so an oracle test can assert the EXACT set of
// deliberate deviations: a value that drifts, or a documented deviation that stops happening, fails the test.
export type Flat = Record<string, string | number | boolean | null>

export function flatten(v: unknown, prefix = '', out: Flat = {}): Flat {
  if (Array.isArray(v)) {
    if (v.length === 0) out[`${prefix}.length`] = 0
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out))
    out[`${prefix}.length`] = v.length
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out)
  } else out[prefix] = v as string | number | boolean | null
  return out
}

export interface Difference {
  path: string
  original: string | number | boolean | null | undefined
  actual: string | number | boolean | null | undefined
}

export function diff(original: unknown, actual: unknown): Difference[] {
  const a = flatten(original)
  const b = flatten(actual)
  const out: Difference[] = []
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[path] !== b[path]) out.push({ path, original: a[path], actual: b[path] })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path, 'en', { numeric: true }))
}

/** { path: [original, actual] } of the differences. */
export function asDeviations(d: readonly Difference[]): Record<string, [unknown, unknown]> {
  return Object.fromEntries(d.map((x) => [x.path, [x.original, x.actual]]))
}
