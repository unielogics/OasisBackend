import { StorageError } from './types.js'

export interface FormFile {
  filename: string
  contentType: string
  data: Buffer
}
export interface ParsedForm {
  fields: Record<string, string>
  file?: FormFile
}

const MAX_PARTS = 24
const MAX_FIELD_BYTES = 8 * 1024
const CRLF2 = Buffer.from('\r\n\r\n')

/** Minimal multipart/form-data reader for the dev upload endpoint: text fields plus at most one file. */
export function parseMultipart(body: Buffer, contentType: string): ParsedForm {
  const m = /boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType)
  const boundary = m?.[1] ?? m?.[2]
  if (!/^multipart\/form-data/i.test(contentType) || !boundary) {
    throw new StorageError('INVALID_ARGUMENT', 'expected multipart/form-data with a boundary')
  }
  const delim = Buffer.from(`--${boundary}`)
  const next = Buffer.from(`\r\n--${boundary}`)
  const form: ParsedForm = { fields: {} }
  let pos = body.indexOf(delim)
  if (pos < 0) throw new StorageError('INVALID_ARGUMENT', 'multipart body has no boundary')
  let parts = 0
  for (;;) {
    pos += delim.length
    if (body.subarray(pos, pos + 2).toString() === '--') return form
    if (body.subarray(pos, pos + 2).toString() !== '\r\n')
      throw new StorageError('INVALID_ARGUMENT', 'malformed multipart body')
    pos += 2
    if (++parts > MAX_PARTS) throw new StorageError('INVALID_ARGUMENT', 'too many multipart parts')
    const headerEnd = body.indexOf(CRLF2, pos)
    if (headerEnd < 0) throw new StorageError('INVALID_ARGUMENT', 'malformed multipart headers')
    const headers = body.subarray(pos, headerEnd).toString('utf8')
    const dataStart = headerEnd + CRLF2.length
    const dataEnd = body.indexOf(next, dataStart)
    if (dataEnd < 0) throw new StorageError('INVALID_ARGUMENT', 'unterminated multipart part')
    const data = body.subarray(dataStart, dataEnd)
    const disp = /^content-disposition:\s*form-data;([^\r\n]*)/im.exec(headers)?.[1] ?? ''
    const name = /\bname="([^"]*)"/.exec(disp)?.[1]
    const filename = /\bfilename="([^"]*)"/.exec(disp)?.[1]
    if (name === undefined) throw new StorageError('INVALID_ARGUMENT', 'multipart part without a name')
    if (filename !== undefined) {
      if (name !== 'file' || form.file)
        throw new StorageError('INVALID_ARGUMENT', 'exactly one file part named "file" is allowed')
      form.file = {
        filename,
        contentType: /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? '',
        data: Buffer.from(data),
      }
    } else {
      if (data.length > MAX_FIELD_BYTES)
        throw new StorageError('INVALID_ARGUMENT', `field "${name}" is too large`)
      form.fields[name] = data.toString('utf8')
    }
    pos = dataEnd + 2 // step over CRLF so `pos` sits on the next delimiter
  }
}
