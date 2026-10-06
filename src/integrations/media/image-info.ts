import { HEIC_MESSAGE, MAX_UPLOAD_BYTES } from '../storage/types.js'
import { sniffImageType } from '../storage/sniff.js'
import { MediaError } from './errors.js'

export interface ImageInfo {
  type: 'image/jpeg' | 'image/png' | 'image/webp'
  width: number
  height: number
  bytes: number
}

export const MAX_INPUT_PIXELS = 40_000_000

const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16)
const u32be = (b: Uint8Array, o: number) => u16be(b, o) * 65536 + u16be(b, o + 2)

function pngSize(b: Uint8Array): [number, number] | null {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
  if (b.length < 24 || String.fromCharCode(...b.slice(12, 16)) !== 'IHDR') return null
  return [u32be(b, 16), u32be(b, 20)]
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let o = 2
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null
    const marker = b[o + 1] as number
    if (marker === 0xff) {
      o += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2
      continue
    }
    const len = u16be(b, o + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return o + 9 <= b.length ? [u16be(b, o + 7), u16be(b, o + 5)] : null
    if (marker === 0xda) return null // start of scan reached without a frame header
    o += 2 + len
  }
  return null
}

function webpSize(b: Uint8Array): [number, number] | null {
  const chunk = String.fromCharCode(...b.slice(12, 16))
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff]
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  if (chunk === 'VP8X' && b.length >= 30) return [u24le(b, 24) + 1, u24le(b, 27) + 1]
  return null
}

/**
 * Pure validation of an uploaded image: size cap, magic bytes (HEIC refused with the same message the upload
 * path uses), optional match against the declared type, and decoded dimensions read from the header only.
 * Nothing is decoded, so a decompression bomb is rejected by its declared pixel count before any decoder runs.
 */
export function validateImageInput(
  buf: Uint8Array,
  opts: { declaredType?: string; maxBytes?: number; maxPixels?: number } = {},
): ImageInfo {
  if (buf.length === 0) throw new MediaError('EMPTY', 'image is empty')
  if (buf.length > (opts.maxBytes ?? MAX_UPLOAD_BYTES))
    throw new MediaError('TOO_LARGE', 'image is larger than the allowed size')
  const type = sniffImageType(buf)
  if (type === 'image/heic') throw new MediaError('HEIC_NOT_SUPPORTED', HEIC_MESSAGE)
  if (!type) throw new MediaError('UNSUPPORTED_TYPE', 'image is not a JPEG, PNG or WebP file')
  if (opts.declaredType && opts.declaredType.split(';')[0]!.trim().toLowerCase() !== type) {
    throw new MediaError('TYPE_MISMATCH', `image content is ${type}, not ${opts.declaredType}`)
  }
  const size = type === 'image/png' ? pngSize(buf) : type === 'image/jpeg' ? jpegSize(buf) : webpSize(buf)
  if (!size || size[0] < 1 || size[1] < 1) throw new MediaError('CORRUPT', 'could not read image dimensions')
  if (size[0] * size[1] > (opts.maxPixels ?? MAX_INPUT_PIXELS)) {
    throw new MediaError('TOO_MANY_PIXELS', `image is ${size[0]}x${size[1]}, which exceeds the pixel limit`)
  }
  return { type, width: size[0], height: size[1], bytes: buf.length }
}
