// GSM 03.38 (GSM-7) normalisation and segment counting.
//
// A single non-GSM character (curly quote, em dash, emoji) flips a whole message to UCS-2, which cuts a segment from 160 to
// 70 characters (153/67 when concatenated). The designs' copy contains "’", "—" and a star emoji, so every outbound body is
// normalised to GSM-7 equivalents first and segments are counted after normalisation.

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM_EXTENDED = '\f^{}\\[~]|€'

const basicSet = new Set(GSM_BASIC.replace('\u001b', ''))
const extendedSet = new Set(GSM_EXTENDED)

export const GSM7_SINGLE = 160
export const GSM7_MULTI = 153
export const UCS2_SINGLE = 70
export const UCS2_MULTI = 67

// [code points, replacement]. Hex code points keep the invisible characters readable.
const TYPOGRAPHY_RULES: Array<[number[], string]> = [
  [[0x2018, 0x2019, 0x201a, 0x201b, 0x02bc, 0x0060, 0x00b4, 0x2032], "'"],
  [[0x201c, 0x201d, 0x201e, 0x201f, 0x00ab, 0x00bb, 0x2033], '"'],
  [[0x2013, 0x2014, 0x2015, 0x2012, 0x2212, 0x2010, 0x2011], '-'],
  [[0x2026], '...'],
  [[0x00a0, 0x2002, 0x2003, 0x2009, 0x200a, 0x202f, 0x3000], ' '],
  [[0x200b, 0x2060, 0xfeff], ''],
  [[0x2022, 0x00b7, 0x25cf], '-'],
  [[0x00d7], 'x'],
  [[0x2039], '<'],
  [[0x203a], '>'],
  [[0x2122, 0x00a9, 0x00ae], ''],
]

const TYPOGRAPHY = new Map<string, string>()
for (const [points, replacement] of TYPOGRAPHY_RULES) for (const cp of points) TYPOGRAPHY.set(String.fromCodePoint(cp), replacement)

// Pictographs, emoji presentation, skin tones, joiners and other format characters, variation selectors, keycap, tags.
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Cf}|\p{Variation_Selector}|[\u{20E3}\u{E0020}-\u{E007F}]/gu

export interface NormalizeOptions {
  /** 'strip' (default) removes emoji; 'keep' leaves them (forcing UCS-2). */
  emoji?: 'strip' | 'keep'
  /** Replace accented Latin letters that GSM-7 lacks (á, ê and ç become a, e and c) with their base letter. Default true. */
  transliterate?: boolean
}

export function isGsm7Char(ch: string): boolean {
  return basicSet.has(ch) || extendedSet.has(ch)
}

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!isGsm7Char(ch)) return false
  return true
}

function transliterateChar(ch: string): string {
  const base = ch.normalize('NFD').replace(/\p{M}/gu, '')
  return base !== ch && isGsm7(base) ? base : ch
}

export function normalizeForSms(text: string, opts: NormalizeOptions = {}): string {
  const emoji = opts.emoji ?? 'strip'
  const transliterate = opts.transliterate ?? true
  let out = text.normalize('NFC')
  let out2 = ''
  for (const ch of out) out2 += TYPOGRAPHY.get(ch) ?? ch
  out = out2
  if (emoji === 'strip') {
    const stripped = out.replace(EMOJI, '')
    if (stripped !== out) out = stripped.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '')
  }
  if (transliterate) {
    let t = ''
    for (const ch of out) t += isGsm7Char(ch) ? ch : transliterateChar(ch)
    out = t
  }
  return out.replace(/\r\n/g, '\n').trim()
}

export type SmsEncoding = 'GSM-7' | 'UCS-2'

export interface SmsEncodingInfo {
  encoding: SmsEncoding
  /** Septets (GSM-7, extension characters count 2) or UTF-16 code units (UCS-2). */
  units: number
  segments: number
  perSegment: number
  /** Units left in the last segment. */
  remaining: number
}

function gsmUnits(ch: string): number {
  return extendedSet.has(ch) ? 2 : 1
}

function countSegments(chars: string[], width: (ch: string) => number, single: number, multi: number) {
  const units = chars.reduce((n, ch) => n + width(ch), 0)
  if (units <= single) return { units, segments: units === 0 ? 0 : 1, perSegment: single, remaining: single - units }
  // A two-unit character (GSM extension, UTF-16 surrogate pair) never straddles a segment boundary.
  let segments = 1
  let used = 0
  for (const ch of chars) {
    const w = width(ch)
    if (used + w > multi) {
      segments += 1
      used = 0
    }
    used += w
  }
  return { units, segments, perSegment: multi, remaining: multi - used }
}

/** Encoding and segment count for text exactly as it will be sent (normalise first). */
export function describeSms(text: string): SmsEncodingInfo {
  const chars = Array.from(text)
  if (chars.every(isGsm7Char)) {
    return { encoding: 'GSM-7', ...countSegments(chars, gsmUnits, GSM7_SINGLE, GSM7_MULTI) }
  }
  return { encoding: 'UCS-2', ...countSegments(chars, (ch) => (ch.length > 1 ? 2 : 1), UCS2_SINGLE, UCS2_MULTI) }
}

export interface PreparedSms extends SmsEncodingInfo {
  body: string
  /** True when normalisation altered the text. */
  changed: boolean
}

export function prepareSmsBody(text: string, opts: NormalizeOptions = {}): PreparedSms {
  const body = normalizeForSms(text, opts)
  return { body, changed: body !== text, ...describeSms(body) }
}

/** The two columns stored per message so cost is reportable: encoding and segment count. */
export function segmentStorage(body: string): { encoding: SmsEncoding; segments: number } {
  const { encoding, segments } = describeSms(body)
  return { encoding, segments }
}
