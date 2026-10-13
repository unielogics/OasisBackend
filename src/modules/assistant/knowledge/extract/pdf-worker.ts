// The PDF reader's worker thread (ADR 0174 §2): unpdf (PDF.js serverless build, no native code) parses the file here, off the
// worker process's event loop, under the parent's resourceLimits (heap) and time limit (terminate). It returns the raw text of each
// page, or why it could not: too many pages, a password, a broken file. Nothing else: the parent cleans the text and decides.
//
// PDF.js runs no document JavaScript without the viewer's scripting sandbox, which is never loaded; fonts are never turned into
// font faces and XFA forms are not rendered, so a /JavaScript action or a font program is data. (`isEvalSupported` of the design is
// gone from PDF.js 5: the eval code path of CVE-2024-4367 was removed, so there is nothing left to switch off.) The parent
// terminates the thread as soon as the answer is posted, which frees the document.
//
// This file is started on its own (worker_threads, plain Node: tsx and vitest load the .ts through Node's type stripping, production
// the compiled .js), so it imports nothing of this project: only Node and unpdf. Before PDF.js sees a file, the prescan below decodes
// its streams with a hard cap (memory PDF.js would take outside the V8 heap).
import { parentPort, workerData } from 'node:worker_threads'
import { constants as zc, inflateSync } from 'node:zlib'
import { getDocumentProxy } from 'unpdf'

export interface PdfWorkerInput {
  bytes: Uint8Array
  maxPages: number
  /** The decoded bytes the file's streams may hold together (prescan); default PDF_DECODED_MAX. */
  maxDecoded?: number
}

export type PdfWorkerOutput =
  | { ok: true; pageCount: number; pages: string[]; tinyChars: number }
  | { ok: false; error: 'encrypted' | 'corrupt' | 'too_many_pages' | 'too_large'; pageCount?: number }

// --- the prescan (K4 review asst:K4A-1) ----------------------------------------------------------------------------------------------
// resourceLimits bound only the V8 heap: PDF.js decodes a stream into Uint8Arrays OUTSIDE the heap, doubling them with no cap, so a
// small inflate bomb grows the whole worker process by gigabytes before the time limit. So before PDF.js sees the file, every stream
// is decoded here the way PDF.js would (FlateDecode, LZWDecode, RunLengthDecode, after ASCIIHexDecode / ASCII85Decode; a stream with
// a zlib header whose filter is not written out plainly is inflated too) with a hard output cap, and a file whose streams hold more
// than PDF_DECODED_MAX bytes together is `too_large`. Memory stays bounded by the cap. An encrypted file (an /Encrypt dictionary, with
// or without an open password) cannot be prescanned (its streams are ciphertext): `encrypted`.

/** Text drawn smaller than this (points) is invisible on the page: left out and counted as hidden. */
export const TINY_TEXT_PT = 2

/** At most this many decoded bytes in all of a file's streams together (real price sheets and policies hold a few MB). */
export const PDF_DECODED_MAX = 128 * 1024 * 1024

class TooLarge extends Error {}

const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1')

function filtersOf(dict: string): string[] | null {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9.#]+|\d+\s+\d+\s+R)/.exec(dict)
  if (!m) return []
  if (/R$/.test(m[1]!)) return null // an indirect filter: not written out plainly
  return [...m[1]!.matchAll(/\/([A-Za-z0-9.#]+)/g)].map((x) => x[1]!)
}

const zlibHeader = (d: Uint8Array): boolean => d.length >= 2 && (d[0]! & 0x0f) === 8 && ((d[0]! << 8) | d[1]!) % 31 === 0

/** Deflate's largest ratio: what a broken stream may still give PDF.js before its error, counted when zlib stops at the error. */
const DEFLATE_MAX_RATIO = 1032

/** The inflated bytes, or (broken data, which PDF.js decodes up to the break) the most it could give, as a number. */
function inflate(d: Uint8Array, room: number): Uint8Array | number {
  try {
    return inflateSync(d, { maxOutputLength: Math.max(1, room + 1), finishFlush: zc.Z_SYNC_FLUSH })
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new TooLarge()
    const bound = d.length * DEFLATE_MAX_RATIO
    if (bound > room) throw new TooLarge()
    return bound
  }
}

function asciiHex(d: Uint8Array): Uint8Array {
  const s = latin1(d).replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '')
  return Buffer.from(s.length % 2 ? `${s}0` : s, 'hex')
}

function ascii85(d: Uint8Array): Uint8Array {
  const s = latin1(d).replace(/~>.*$/s, '').replace(/^<~/, '').replace(/\s+/g, '')
  const out: number[] = []
  let group: number[] = []
  const flush = (n: number): void => {
    let v = 0
    for (let i = 0; i < 5; i++) v = v * 85 + (group[i] ?? 84)
    for (let i = 0; i < n - 1; i++) out.push((v >>> (24 - 8 * i)) & 0xff)
  }
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    const c = ch.charCodeAt(0) - 33
    if (c < 0 || c > 84) continue
    group.push(c)
    if (group.length === 5) {
      flush(5)
      group = []
    }
  }
  if (group.length > 1) flush(group.length)
  return Uint8Array.from(out)
}

/** RunLengthDecode with a cap. */
function runLength(d: Uint8Array, room: number): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < d.length; ) {
    const n = d[i]!
    if (n === 128) break
    if (n < 128) {
      for (let k = 1; k <= n + 1 && i + k < d.length; k++) out.push(d[i + k]!)
      i += n + 2
    } else {
      for (let k = 0; k < 257 - n; k++) out.push(d[i + 1] ?? 0)
      i += 2
    }
    if (out.length > room) throw new TooLarge()
  }
  return Uint8Array.from(out)
}

/** LZWDecode (EarlyChange 1, as PDF.js) with a cap: only the length of what it would produce is needed (the chain stops here). */
function lzwLength(d: Uint8Array, room: number): number {
  const lens = new Uint16Array(4096)
  let next = 258
  let codeLen = 9
  let prev = -1
  let total = 0
  let bits = 0
  let acc = 0
  for (let i = 0; i < d.length; i++) {
    acc = ((acc << 8) | d[i]!) >>> 0
    bits += 8
    while (bits >= codeLen) {
      const code = (acc >>> (bits - codeLen)) & ((1 << codeLen) - 1)
      bits -= codeLen
      if (code === 256) {
        next = 258
        codeLen = 9
        prev = -1
        continue
      }
      if (code === 257) return total
      let len: number
      if (code < 256) len = 1
      else if (code < next) len = lens[code]!
      else if (code === next && prev >= 0) len = prev + 1
      else return total // broken data
      if (prev >= 0 && next < 4096) lens[next++] = Math.min(prev + 1, 65_535)
      total += len
      if (total > room) throw new TooLarge()
      prev = len
      if (next + 1 >= 1 << codeLen && codeLen < 12) codeLen++
    }
  }
  return total
}

/** The decoded size of one stream as PDF.js would decode it (throws TooLarge past `room`). */
function decodedSize(dict: string, raw: Uint8Array, room: number): number {
  const filters = filtersOf(dict)
  if (filters === null) {
    if (!zlibHeader(raw)) return raw.length
    const r = inflate(raw, room)
    return typeof r === 'number' ? r : r.length
  }
  let data = raw
  for (const f of filters) {
    if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data)
    else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data)
    else if (f === 'FlateDecode' || f === 'Fl') {
      const r = inflate(data, room)
      if (typeof r === 'number') return r
      data = r
    }
    else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data, room)
    else if (f === 'LZWDecode' || f === 'LZW') return lzwLength(data, room)
    else return data.length // images (DCT, JPX, JBIG2, CCITT) and the rest: PDF.js reads no text from them
    if (data.length > room) throw new TooLarge()
  }
  return data.length
}

/** too_large when the streams hold more than `max` decoded bytes together; encrypted for an /Encrypt dictionary; else null. */
export function prescanPdf(bytes: Uint8Array, max = PDF_DECODED_MAX): 'too_large' | 'encrypted' | null {
  const text = latin1(bytes)
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(text)) return 'encrypted'
  let total = 0
  const re = /stream(\r\n|\n|\r)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index
    if (!/>>\s*$/.test(text.slice(Math.max(0, at - 64), at))) continue // a stream keyword ends a dictionary ("endstream" does not)
    const objAt = text.lastIndexOf(' obj', at)
    const dict = text.slice(objAt < 0 ? Math.max(0, at - 4096) : objAt, at)
    const start = at + m[0].length
    const len = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict) // a direct length (an indirect one: look for endstream)
    let end = len ? start + Number(len[1]) : -1
    if (end < start || end > text.length || !/^\s*endstream/.test(text.slice(end, end + 32))) end = text.indexOf('endstream', start)
    if (end < 0) end = text.length
    try {
      total += decodedSize(dict, bytes.subarray(start, end), max - total)
    } catch (e) {
      if (e instanceof TooLarge) return 'too_large'
      throw e
    }
    if (total > max) return 'too_large'
    re.lastIndex = Math.max(re.lastIndex, end)
  }
  return null
}

async function read(input: PdfWorkerInput): Promise<PdfWorkerOutput> {
  const pre = prescanPdf(input.bytes, input.maxDecoded ?? PDF_DECODED_MAX)
  if (pre) return { ok: false, error: pre }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(input.bytes, {
      disableFontFace: true,
      enableXfa: false,
      stopAtErrors: false,
      useSystemFonts: false,
    })
  } catch (e) {
    const name = (e as { name?: string })?.name ?? ''
    return { ok: false, error: /password/i.test(name) ? 'encrypted' : 'corrupt' }
  }
  try {
    if (pdf.numPages > input.maxPages) return { ok: false, error: 'too_many_pages', pageCount: pdf.numPages }
    // each page's text as unpdf's extractText joins it, without text drawn too small to see (under 2 pt: a reader never sees it, so it
    // is no part of what the owner reviews; it is counted with the hidden characters: K4 review asst:K4A-3)
    const pages: string[] = []
    let tinyChars = 0
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent()
      let text = ''
      for (const item of content.items) {
        if (!('str' in item) || item.str == null) continue
        const [, , c, d] = item.transform as number[]
        const tiny = Math.hypot(c ?? 0, d ?? 0) < TINY_TEXT_PT && item.str.trim() !== ''
        if (tiny) tinyChars += item.str.replace(/\s+/g, '').length
        text += (tiny ? '' : item.str) + (item.hasEOL ? '\n' : '')
      }
      pages.push(text)
    }
    return { ok: true, pageCount: pdf.numPages, pages, tinyChars }
  } catch (e) {
    const name = (e as { name?: string })?.name ?? ''
    return { ok: false, error: /password/i.test(name) ? 'encrypted' : 'corrupt' }
  }
}

if (parentPort) {
  const port = parentPort
  read(workerData as PdfWorkerInput).then(
    (out) => port.postMessage(out),
    () => port.postMessage({ ok: false, error: 'corrupt' }),
  )
}
