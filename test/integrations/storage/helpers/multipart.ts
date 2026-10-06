export function multipartBody(
  fields: Record<string, string>,
  file: { data: Buffer; filename?: string; contentType?: string } | null,
  boundary = '----oasistest1234',
) {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename ?? 'photo.jpg'}"\r\nContent-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

// Tiny valid-looking headers; the dev handler only sniffs magic bytes.
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
])
export const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x40, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(64, 3),
])
export const HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypheic'),
  Buffer.alloc(64, 4),
])
