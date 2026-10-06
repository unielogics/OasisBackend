import { describe, expect, it } from 'vitest'
import { CSV_BOM, csvCell, toCsv, type CsvColumn } from '../../src/platform/csv.js'

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"')
  })

  it('neutralises spreadsheet formulas in text cells', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(csvCell('+1 305 555 0142')).toBe("'+1 305 555 0142")
    expect(csvCell('-Evil')).toBe("'-Evil")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('\tTabbed')).toBe("'\tTabbed")
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"')
  })

  it('does not touch numeric columns, empties or booleans', () => {
    expect(csvCell('-2.50', 'number')).toBe('-2.50')
    expect(csvCell(-250, 'number')).toBe('-250')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(true)).toBe('true')
  })

  it('only the first character decides', () => {
    expect(csvCell('a=b')).toBe('a=b')
    expect(csvCell('Sam-1')).toBe('Sam-1')
  })
})

describe('toCsv', () => {
  type Row = { invoice: string; client: string; total: string }
  const cols: CsvColumn<Row>[] = [
    { header: 'Invoice', value: (r) => r.invoice },
    { header: 'Client', value: (r) => r.client },
    { header: 'Total', kind: 'number', value: (r) => r.total },
  ]

  it('emits BOM, header row and CRLF line ends', () => {
    const out = toCsv(cols, [
      { invoice: 'INV-20604', client: 'Chloe, Bennett', total: '196.88' },
      { invoice: 'INV-20602', client: '=cmd', total: '-25.00' },
    ])
    expect(out.startsWith(CSV_BOM)).toBe(true)
    expect(out.slice(1)).toBe(
      'Invoice,Client,Total\r\nINV-20604,"Chloe, Bennett",196.88\r\nINV-20602,\'=cmd,-25.00\r\n',
    )
  })

  it('can omit the BOM and handles an empty result set', () => {
    expect(toCsv(cols, [], false)).toBe('Invoice,Client,Total\r\n')
  })
})
