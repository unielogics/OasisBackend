// Reading a PDF (ADR 0174 §2, K4 review K4REV-1): the bytes go to a CHILD PROCESS (pdf-worker.ts, plain Node) started under prlimit,
// so the operating system bounds everything it allocates (`--data`: the V8 heap and the buffers PDF.js decodes outside it alike), its
// CPU time (`--cpu`) and its core dumps (none); it is killed (SIGKILL) at the 30-second deadline. A heavy or hostile file (an inflate
// bomb hidden from any prescan) can therefore only kill that child: the worker process that also sends the live SMS turns and runs
// every other job never holds the decoded data and its event loop only waits on a pipe. A child that ran out of its memory is
// too_large, one killed at the deadline (or by its CPU limit) timeout. Without prlimit nothing is read (fail closed: corrupt, and the
// job logs an error). The raw page texts come back as JSON on stdout and are cleaned here (clean.ts); fewer than about 40 non-space
// characters per page on average is a scan (no_text: no OCR).
import { spawn } from 'node:child_process'
import { accessSync, constants as fsc } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cleanPdfText, looksScanned } from './clean.js'
import type { PdfWorkerOutput } from './pdf-worker.js'
import type { DocumentError } from '../schema.js'

export const PDF_LIMITS = {
  maxPages: 60,
  timeoutMs: 30_000,
  /** The child's writable memory in all (RLIMIT_DATA): heap, decoded streams, thread stacks. */
  memoryMb: 384,
  /** The child's V8 old generation (inside memoryMb). */
  heapMb: 192,
} as const

export type PdfLimits = { [K in keyof typeof PDF_LIMITS]: number }

/** Where prlimit (util-linux) is looked for; only an absolute path is ever run. */
export const PRLIMIT_PATHS = ['/usr/bin/prlimit', '/bin/prlimit'] as const

/** The argument that starts pdf-worker.ts as the reader's child (its own CHILD_FLAG: that file imports nothing of this one, and
 * this one only its types, so the worker process never loads PDF.js). */
export const PDF_CHILD_FLAG = '--oasis-pdf-child'

/** At most this much JSON is read back from the child (its text is capped at PDF_TEXT_MAX characters). */
const STDOUT_MAX = 16 * 1024 * 1024
/** The last bytes of the child's stderr kept to tell a memory failure from a crash. */
const STDERR_TAIL = 8 * 1024

export type ExtractResult =
  | { ok: true; text: string; pageCount: number; removedChars: number; removedTags: number; cut: boolean }
  | { ok: false; error: DocumentError; pageCount?: number }

export interface ReadOptions {
  /** prlimit's path; null = not available (fail closed). Default: the first of PRLIMIT_PATHS that can be run. */
  prlimit?: string | null
  /** Called with the child's pid once it runs (tests: the child never outlives the deadline). */
  onSpawn?: (pid: number) => void
}

/** The first prlimit this process can run, or null. */
export function findPrlimit(paths: readonly string[] = PRLIMIT_PATHS): string | null {
  for (const p of paths) {
    try {
      accessSync(p, fsc.X_OK)
      return p
    } catch {
      // next
    }
  }
  return null
}

/** Whether PDFs can be read on this host (prlimit present). */
export const pdfSandboxAvailable = (): boolean => findPrlimit() !== null

/** The child's file: the compiled .js next to this one in production, the .ts source under tsx and vitest. */
export function pdfWorkerPath(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url))
}

type ReadResult = PdfWorkerOutput | { ok: false; error: 'timeout' | 'too_large' | 'corrupt' }

/** Runs the child over the bytes; never throws for the file's own problems (they are the result's error). */
export function readPdf(bytes: Uint8Array, limits: Partial<PdfLimits> = {}, opts: ReadOptions = {}): Promise<ReadResult> {
  const l = { ...PDF_LIMITS, ...limits }
  const prlimit = opts.prlimit === undefined ? findPrlimit() : opts.prlimit
  if (!prlimit) return Promise.resolve({ ok: false, error: 'corrupt' })
  return new Promise((resolve) => {
    const args = [
      `--data=${Math.round(l.memoryMb * 1024 * 1024)}`,
      `--cpu=${Math.ceil(l.timeoutMs / 1000) + 1}`,
      '--core=0',
      '--',
      process.execPath,
      `--max-old-space-size=${l.heapMb}`,
      '--max-semi-space-size=8',
      '--disable-warning=ExperimentalWarning',
      pdfWorkerPath(),
      PDF_CHILD_FLAG,
      String(l.maxPages),
    ]
    let settled = false
    let deadline = false
    let outLen = 0
    let overflow = false
    const out: Buffer[] = []
    let err = ''
    // no environment: the child needs none, and the worker's secrets stay out of it
    const child = spawn(prlimit, args, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = (r: ReadResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(fallback)
      resolve(r)
    }
    let fallback: NodeJS.Timeout | undefined
    const kill = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      deadline = true
      kill()
      // the exit is awaited (so the child is gone when this resolves); a child that never reports it still ends the read
      fallback = setTimeout(() => finish({ ok: false, error: 'timeout' }), 2000)
      fallback.unref?.()
    }, l.timeoutMs)
    timer.unref?.()
    if (child.pid !== undefined) opts.onSpawn?.(child.pid)
    child.on('error', () => {
      // prlimit could not be started: nothing is read
      kill()
      finish({ ok: false, error: 'corrupt' })
    })
    child.stdin.on('error', () => undefined) // the child died before reading everything: its exit tells why
    child.stdout.on('data', (c: Buffer) => {
      outLen += c.length
      if (outLen > STDOUT_MAX) {
        overflow = true
        kill()
        return
      }
      out.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      err = (err + c.toString('utf8')).slice(-STDERR_TAIL)
    })
    child.on('close', (code, signal) => {
      if (deadline) return finish({ ok: false, error: 'timeout' })
      if (overflow) return finish({ ok: false, error: 'too_large' })
      if (signal === 'SIGXCPU' || signal === 'SIGKILL') return finish({ ok: false, error: 'timeout' })
      if (code === 0 && !signal) {
        try {
          return finish(JSON.parse(Buffer.concat(out).toString('utf8')) as PdfWorkerOutput)
        } catch {
          return finish({ ok: false, error: 'corrupt' })
        }
      }
      // died on its own: out of the memory its limits allow (V8's fatal "out of memory", a failed allocation), or a crash
      finish({ ok: false, error: /memory|allocation|alloc failed/i.test(err) || signal === 'SIGABRT' || signal === 'SIGTRAP' ? 'too_large' : 'corrupt' })
    })
    child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  })
}

/** The cleaned text of a PDF, or why there is none. */
export async function extractPdf(bytes: Uint8Array, limits: Partial<PdfLimits> = {}, opts: ReadOptions = {}): Promise<ExtractResult> {
  const r = await readPdf(bytes, limits, opts)
  if (!r.ok) return r
  const clean = cleanPdfText(r.pages)
  if (looksScanned(clean.text, r.pageCount)) return { ok: false, error: 'no_text', pageCount: r.pageCount }
  // text too small to see is left out by the child and counted with the hidden characters (the review shows "N hidden characters")
  const removedChars = clean.removedChars + (r.tinyChars ?? 0)
  return { ok: true, text: clean.text, pageCount: r.pageCount, removedChars, removedTags: clean.removedTags, cut: clean.cut || r.truncated === true }
}
