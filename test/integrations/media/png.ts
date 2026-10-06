import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Smallest honest encoder: an 8-bit RGB PNG with a diagonal gradient. Independent of sharp. */
export function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const row = (y: number) => {
    const r = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      r[1 + x * 3] = (x * 255) / Math.max(1, width - 1)
      r[2 + x * 3] = (y * 255) / Math.max(1, height - 1)
      r[3 + x * 3] = 128
    }
    return r
  }
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => row(y)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
