// Magic-byte detection shared by the dev upload handler and the media validator.
export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null

export function sniffImageType(b: Uint8Array): SniffedType {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v))
    return 'image/png'
  const ascii = (from: number, len: number) => String.fromCharCode(...b.slice(from, from + len))
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (
    b.length >= 12 &&
    ascii(4, 4) === 'ftyp' &&
    /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(ascii(8, 4))
  ) {
    return 'image/heic'
  }
  return null
}
