// Kysely types for the assistant's knowledge (migration 20261016200100_assistant_knowledge.sql, ADR 0174): the owner's entries
// (notes, the reviewed text of PDFs, corrections) and the uploaded PDF documents. Registered by module augmentation.
import type { ColumnType, Generated } from 'kysely'

export type KnowledgeKind = 'note' | 'document' | 'correction'
export type KnowledgeSource = 'manual' | 'practice' | 'live'
export type DocumentStatus = 'pending_upload' | 'extracting' | 'ready' | 'failed' | 'deleted'
export type DocumentError = 'no_text' | 'encrypted' | 'corrupt' | 'too_many_pages' | 'timeout' | 'not_pdf' | 'too_large'

/** What the editor warns about in an entry's text (sanitize.ts). `line` is 1-based (0: the entry as a whole). */
export type KnowledgeWarningKind = 'amount' | 'link' | 'phone' | 'email' | 'instruction' | 'promise' | 'hidden' | 'markup' | 'long'
export interface KnowledgeWarning {
  kind: KnowledgeWarningKind
  /** The words found (at most 40 characters). */
  sample: string
  line: number
}

export interface AssistantKnowledgeTable {
  id: string
  location_id: string
  kind: KnowledgeKind
  title: string
  body: string
  question: string | null
  wrong_reply: string | null
  source: Generated<KnowledgeSource>
  assistant_turn_id: string | null
  practice_turn_id: string | null
  document_id: string | null
  active: Generated<boolean>
  reviewed_at: Date | null
  /** jsonb, written as JSON text (default '[]'). */
  warnings: ColumnType<KnowledgeWarning[], string | undefined, string>
  chars: number
  sort: Generated<number>
  version: Generated<number>
  created_by: string | null
  updated_by: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface AssistantKnowledgeDocumentsTable {
  id: string
  location_id: string
  filename: string
  content_type: string
  bytes: number
  sha256: string | null
  s3_key: string
  status: Generated<DocumentStatus>
  error_code: DocumentError | null
  page_count: number | null
  extracted_text: string | null
  removed_chars: Generated<number>
  attempts: Generated<number>
  uploaded_by: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: Date | null
  object_deleted_at: Date | null
}

declare module '../../../platform/schema.js' {
  interface Database {
    assistant_knowledge: AssistantKnowledgeTable
    assistant_knowledge_documents: AssistantKnowledgeDocumentsTable
  }
}
