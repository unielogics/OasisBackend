// Template-independent email content model. Templates build a Doc from already-validated variables and
// both renderers consume it, so HTML escaping lives in exactly one place and the two parts cannot drift.

export type Block =
  | { t: 'p'; text: string }
  | { t: 'facts'; rows: ReadonlyArray<readonly [label: string, value: string]> }
  | { t: 'items'; rows: ReadonlyArray<readonly [label: string, amount: string]>; emphasizeLast?: boolean }
  | { t: 'button'; label: string; url: string }
  | { t: 'note'; text: string }

export interface Doc {
  subject: string
  heading: string
  blocks: Block[]
  footer: string
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const wrap = (s: string, width: number): string => {
  const out: string[] = []
  for (const para of s.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

export function renderText(doc: Doc): string {
  const parts: string[] = [doc.heading, '']
  for (const b of doc.blocks) {
    switch (b.t) {
      case 'p':
      case 'note':
        parts.push(wrap(b.text, 76), '')
        break
      case 'facts': {
        const w = Math.max(...b.rows.map(([l]) => l.length))
        for (const [l, v] of b.rows) parts.push(`${l.padEnd(w)}  ${v}`)
        parts.push('')
        break
      }
      case 'items': {
        const w = Math.max(...b.rows.map(([l]) => l.length))
        const aw = Math.max(...b.rows.map(([, a]) => a.length))
        b.rows.forEach(([l, a], i) => {
          if (b.emphasizeLast && i === b.rows.length - 1) parts.push('-'.repeat(w + aw + 2))
          parts.push(`${l.padEnd(w)}  ${a.padStart(aw)}`)
        })
        parts.push('')
        break
      }
      case 'button':
        parts.push(`${b.label}: ${b.url}`, '')
        break
    }
  }
  parts.push('--', doc.footer)
  return parts.join('\n') + '\n'
}

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const INK = '#14202b'
const MUTED = '#5b6b7a'
const RULE = '#dde3e9'
const ACCENT = '#0b6e8a'

function htmlBlock(b: Block): string {
  switch (b.t) {
    case 'p':
      return `<p style="margin:0 0 16px;font:15px/1.5 ${FONT};color:${INK}">${escapeHtml(b.text).replace(/\n/g, '<br>')}</p>`
    case 'note':
      return `<p style="margin:0 0 16px;font:13px/1.5 ${FONT};color:${MUTED}">${escapeHtml(b.text).replace(/\n/g, '<br>')}</p>`
    case 'facts':
      return (
        `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 16px;width:100%;border-collapse:collapse">` +
        b.rows
          .map(
            ([l, v]) =>
              `<tr><td style="padding:6px 12px 6px 0;font:13px/1.4 ${FONT};color:${MUTED};vertical-align:top;white-space:nowrap">${escapeHtml(l)}</td>` +
              `<td style="padding:6px 0;font:14px/1.4 ${FONT};color:${INK}">${escapeHtml(v)}</td></tr>`,
          )
          .join('') +
        `</table>`
      )
    case 'items':
      return (
        `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 16px;width:100%;border-collapse:collapse">` +
        b.rows
          .map(([l, a], i) => {
            const last = !!b.emphasizeLast && i === b.rows.length - 1
            const border = last ? `border-top:1px solid ${RULE};` : ''
            const weight = last ? 'font-weight:700;' : ''
            return (
              `<tr><td style="padding:6px 12px 6px 0;${border}${weight}font:14px/1.4 ${FONT};color:${INK}">${escapeHtml(l)}</td>` +
              `<td style="padding:6px 0;${border}${weight}font:14px/1.4 ${FONT};color:${INK};text-align:right;white-space:nowrap">${escapeHtml(a)}</td></tr>`
            )
          })
          .join('') +
        `</table>`
      )
    case 'button':
      return (
        `<p style="margin:0 0 20px"><a href="${escapeHtml(b.url)}" style="display:inline-block;padding:11px 20px;border-radius:8px;` +
        `background:${ACCENT};color:#ffffff;font:600 15px/1 ${FONT};text-decoration:none">${escapeHtml(b.label)}</a></p>` +
        `<p style="margin:0 0 16px;font:12px/1.5 ${FONT};color:${MUTED}">If the button does not work, copy this link into your browser:<br>` +
        `<span style="word-break:break-all">${escapeHtml(b.url)}</span></p>`
      )
  }
}

/** Self-contained HTML: inline styles, system fonts, no images, no stylesheets, no remote assets. */
export function renderHtml(doc: Doc): string {
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(doc.subject)}</title></head>` +
    `<body style="margin:0;padding:24px 12px;background:#f3f6f8">` +
    `<table role="presentation" cellspacing="0" cellpadding="0" align="center" style="width:100%;max-width:560px;background:#ffffff;border:1px solid ${RULE};border-radius:12px">` +
    `<tr><td style="padding:28px 28px 12px">` +
    `<h1 style="margin:0 0 20px;font:700 20px/1.3 ${FONT};color:${INK}">${escapeHtml(doc.heading)}</h1>` +
    doc.blocks.map(htmlBlock).join('') +
    `</td></tr>` +
    `<tr><td style="padding:12px 28px 24px;border-top:1px solid ${RULE};font:12px/1.5 ${FONT};color:${MUTED}">${escapeHtml(doc.footer).replace(/\n/g, '<br>')}</td></tr>` +
    `</table></body></html>\n`
  )
}
