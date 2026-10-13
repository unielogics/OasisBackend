export interface UploadSlot {
  key: string
  /** Presigned POST (s3) or signed dev URL (fs). The policy enforces content type and a size range. */
  url: string
  fields: Record<string, string>
  expiresAt: Date
}

export interface StorageProvider {
  createUpload(p: { key: string; contentType: string; maxBytes: number; ttlSec: number }): Promise<UploadSlot>
  head(key: string): Promise<{ bytes: number; contentType: string } | null>
  /** Inline by default; `attachment` names the file the browser saves (ADR 0174: knowledge PDFs). */
  getDownloadUrl(key: string, ttlSec: number, o?: { attachment?: string }): Promise<string>
  delete(key: string): Promise<void>
}
