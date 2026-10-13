// Reading a PDF (ADR 0174 §2): the bytes go to a worker_threads Worker (pdf-worker.ts) with a 256 MB heap (32 MB young generation)
// and a 30-second limit, so a heavy or hostile file can neither stall the worker process that also sends the live SMS turns nor
// take its memory: the thread is terminated at the deadline (timeout) and dies alone when it runs out of heap (too_large). The raw
// page texts come back and are cleaned here (clean.ts); fewer than about 40 non-space characters per page on average is a scan
// (no_text: no OCR).
import { Worker } from 'node:worker_threads'
import { cleanPdfText, looksScanned } from './clean.js'
import type { PdfWorkerOutput } from './pdf-worker.js'
import type { DocumentError } from '../schema.js'

export const PDF_LIMITS = {
  maxPages: 60,
  timeoutMs: 30_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
} as const

export type PdfLimits = { [K in keyof typeof PDF_LIMITS]: number }

export type ExtractResult =
  | { ok: true; text: string; pageCount: number; removedChars: number; removedTags: number; cut: boolean }
  | { ok: false; error: DocumentError; pageCount?: number }

/** The worker's file: the compiled .js next to this one in production, the .ts source under tsx and vitest. */
export function pdfWorkerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url)
}

/** Runs the worker over the bytes; never throws for the file's own problems (they are the result's error). */
export function readPdf(bytes: Uint8Array, limits: Partial<PdfLimits> = {}): Promise<PdfWorkerOutput | { ok: false; error: 'timeout' | 'too_large' }> {
  const l = { ...PDF_LIMITS, ...limits }
  // a copy the worker owns (the caller's buffer stays usable)
  const copy = new Uint8Array(bytes)
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(pdfWorkerUrl(), {
      workerData: { bytes: copy, maxPages: l.maxPages },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: l.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: l.maxYoungGenerationSizeMb },
      stdout: true,
      stderr: true,
    })
    const done = (r: PdfWorkerOutput | { ok: false; error: 'timeout' | 'too_large' }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => undefined)
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), l.timeoutMs)
    timer.unref?.()
    worker.on('message', (m: PdfWorkerOutput) => done(m))
    worker.on('error', (e: Error & { code?: string }) =>
      done({ ok: false, error: e.code === 'ERR_WORKER_OUT_OF_MEMORY' || /heap|memory/i.test(e.message) ? 'too_large' : 'corrupt' }),
    )
    worker.on('exit', () => done({ ok: false, error: 'corrupt' }))
  })
}

/** The cleaned text of a PDF, or why there is none. */
export async function extractPdf(bytes: Uint8Array, limits: Partial<PdfLimits> = {}): Promise<ExtractResult> {
  const r = await readPdf(bytes, limits)
  if (!r.ok) return r
  const clean = cleanPdfText(r.pages)
  if (looksScanned(clean.text, r.pageCount)) return { ok: false, error: 'no_text', pageCount: r.pageCount }
  return { ok: true, text: clean.text, pageCount: r.pageCount, removedChars: clean.removedChars, removedTags: clean.removedTags, cut: clean.cut }
}
