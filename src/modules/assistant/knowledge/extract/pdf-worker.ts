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
// the compiled .js), so it imports nothing of this project: only Node and unpdf.
import { parentPort, workerData } from 'node:worker_threads'
import { extractText, getDocumentProxy } from 'unpdf'

export interface PdfWorkerInput {
  bytes: Uint8Array
  maxPages: number
}

export type PdfWorkerOutput =
  | { ok: true; pageCount: number; pages: string[] }
  | { ok: false; error: 'encrypted' | 'corrupt' | 'too_many_pages'; pageCount?: number }

async function read(input: PdfWorkerInput): Promise<PdfWorkerOutput> {
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
    const { totalPages, text } = await extractText(pdf, { mergePages: false })
    return { ok: true, pageCount: totalPages, pages: Array.isArray(text) ? text : [String(text)] }
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
