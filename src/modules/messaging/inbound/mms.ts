// Inbound MMS (ADR 0151): what Oasis keeps of a downloaded MMS besides its text. Pure: deciding which parts are saved and
// under which key; the effects do the storage I/O. An MMS's text goes through the same router as an SMS.
import { createHash } from 'node:crypto'
import type { MmsPart } from '../../../integrations/ports/sms.js'
import { PHOTO_TYPES } from '../../../integrations/storage/types.js'
import { sniffImageType } from '../../../integrations/storage/sniff.js'

/** Pictures saved per MMS, and the largest one saved. */
export const MMS_MAX_SAVED_PICTURES = 5
export const MMS_MAX_PICTURE_BYTES = 5 * 1024 * 1024

/** The text stored for an MMS with no text: it had parts (a picture), or nothing usable at all. */
export const PICTURE_MESSAGE_TEXT = '[Picture message]'
export const PICTURE_UNAVAILABLE_TEXT = '[Picture message — content unavailable]'

export type MmsPlaceholder = 'picture' | 'unavailable'

export type MmsAttachmentStatus = 'stored' | 'listed' | 'unavailable' | 'skipped'
export type MmsAttachmentReason = 'missing' | 'decode_failed' | 'too_large' | 'limit' | 'unsupported_type' | 'storage_error'

/** One part as stored in messages.attachments / sms_inbox.attachments. `key` is the object key in the photos store when saved. */
export interface MmsAttachmentRecord {
  index: number
  partId: string | null
  name: string | null
  contentType: string
  size: number | null
  status: MmsAttachmentStatus
  reason: MmsAttachmentReason | null
  key: string | null
}

/** What the effects must do with each part: save the bytes under `key`, or just record it. */
export type MmsPlanItem = { record: MmsAttachmentRecord; save: { key: string; body: Buffer; contentType: string } | null }

/** The text an MMS is filed with: its own text, else a placeholder saying a picture came (or that nothing could be read). */
export function mmsText(body: string, parts: readonly MmsPart[]): { text: string; placeholder: MmsPlaceholder | null } {
  const text = body.trim()
  if (text) return { text, placeholder: null }
  return parts.length > 0 ? { text: PICTURE_MESSAGE_TEXT, placeholder: 'picture' } : { text: PICTURE_UNAVAILABLE_TEXT, placeholder: 'unavailable' }
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** A storage-key segment for the device's message id: itself when already safe, else a readable prefix plus a short hash. */
export function messageSegment(providerMessageId: string): string {
  if (SEGMENT.test(providerMessageId)) return providerMessageId
  const hash = createHash('sha256').update(providerMessageId).digest('hex').slice(0, 16)
  const readable = providerMessageId.replace(/[^A-Za-z0-9_-]+/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40)
  return readable ? `${readable}-${hash}` : `m${hash}`
}

/** messaging/mms/<location>/<message>/<index>.<ext>: deterministic, so a retried event overwrites rather than duplicates. */
export function mmsAttachmentKey(locationId: string, providerMessageId: string, index: number, ext: string): string {
  return `messaging/mms/${locationId}/${messageSegment(providerMessageId)}/${index}.${ext}`
}

/**
 * Decides, part by part, what is saved: image/* parts with bytes, at most MMS_MAX_SAVED_PICTURES of up to
 * MMS_MAX_PICTURE_BYTES each, in a format the photos store accepts (checked on the bytes, not only the declared type).
 * Everything else is recorded by name, type and size; a part whose bytes are missing or broken is 'unavailable'.
 */
export function planAttachments(locationId: string, providerMessageId: string, parts: readonly MmsPart[]): MmsPlanItem[] {
  let saved = 0
  return parts.map((p, index) => {
    const record: MmsAttachmentRecord = { index, partId: p.partId, name: p.name, contentType: p.contentType, size: p.size, status: 'listed', reason: null, key: null }
    if (!p.contentType.startsWith('image/')) return { record, save: null }
    if (p.data === null) return { record: { ...record, status: 'unavailable', reason: p.problem ?? 'missing' }, save: null }
    if (p.data.length > MMS_MAX_PICTURE_BYTES) return { record: { ...record, status: 'skipped', reason: 'too_large' }, save: null }
    const sniffed = sniffImageType(p.data)
    const ext = sniffed ? PHOTO_TYPES[sniffed] : undefined
    if (!sniffed || !ext) return { record: { ...record, status: 'skipped', reason: 'unsupported_type' }, save: null }
    if (saved >= MMS_MAX_SAVED_PICTURES) return { record: { ...record, status: 'skipped', reason: 'limit' }, save: null }
    saved += 1
    const key = mmsAttachmentKey(locationId, providerMessageId, index, ext)
    return { record: { ...record, contentType: sniffed, status: 'stored', key }, save: { key, body: p.data, contentType: sniffed } }
  })
}
