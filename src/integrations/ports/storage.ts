export interface UploadSlot {
  key: string
  /** Presigned POST (s3) or signed dev URL (fs). The policy enforces content type and a size range. */
  url: string
  fields: Record<string, string>
  expiresAt: Date
}

export interface StorageProvider {
  /** `allowedTypes`: the purpose's content types (default: by the key, ADR 0174: kb/ keys take PDFs, every other key photos). */
  createUpload(p: { key: string; contentType: string; maxBytes: number; ttlSec: number; allowedTypes?: Readonly<Record<string, string>> }): Promise<UploadSlot>
  head(key: string): Promise<{ bytes: number; contentType: string } | null>
  /** Inline by default; `attachment` names the file the browser saves (ADR 0174: knowledge PDFs). */
  getDownloadUrl(key: string, ttlSec: number, o?: { attachment?: string }): Promise<string>
  delete(key: string): Promise<void>
}
