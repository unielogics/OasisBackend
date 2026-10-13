// The knowledge jobs (ADR 0174 §2), each run twice: the second run changes nothing (the dedicated suite of test/jobs/matrix.test.ts).
//   assistant.knowledge.extract   reads the PDF of a document still extracting: the text and a draft entry; once ready it is skipped
//   assistant.knowledge.cleanup   abandoned uploads and their objects, stuck extractions, objects of deleted documents
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { createStorageProvider } from '../../src/integrations/storage/config.js'
import { buildKnowledgeKey } from '../../src/integrations/storage/keys.js'
import { CLEANUP_JOB, EXTRACT_JOB } from '../../src/modules/assistant/knowledge/documents.js'
import { knowledgeCleanupJob, knowledgeExtractJob, knowledgeJobs } from '../../src/modules/assistant/knowledge/jobs.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { useKnowledgeHarness } from './harness.js'
import { textPdf } from './pdf-fixtures.js'

const h = useKnowledgeHarness()
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined } as never

async function document(status: 'extracting' | 'pending_upload', o: { minutesAgo?: number } = {}) {
  const id = createIdGenerator(h.clock)()
  const key = buildKnowledgeKey({ locationId: h.fx.locationId, documentId: id })
  const storage = createStorageProvider(loadEnv(), { clock: h.clock })
  await storage.put(key, textPdf(), 'application/pdf')
  const at = new Date(h.clock.now().getTime() - (o.minutesAgo ?? 0) * 60_000)
  await h.db
    .insertInto('assistant_knowledge_documents')
    .values({ id, location_id: h.fx.locationId, filename: 'guide.pdf', content_type: 'application/pdf', bytes: 1000, s3_key: key, status, created_at: at, updated_at: at })
    .execute()
  return { id, key, storage }
}

const snapshot = async () =>
  JSON.stringify({
    docs: await h.db.selectFrom('assistant_knowledge_documents').select(['id', 'status', 'error_code', 'page_count', 'object_deleted_at']).orderBy('id').execute(),
    entries: await h.db.selectFrom('assistant_knowledge').select(['id', 'document_id', 'active', 'chars']).orderBy('id').execute(),
  })

describe('the knowledge jobs', () => {
  it('are registered under their names, extract queue-only and cleanup every 15 minutes', () => {
    expect(knowledgeJobs.map((j) => j.name)).toEqual([EXTRACT_JOB, CLEANUP_JOB])
    expect(knowledgeExtractJob).toMatchObject({ name: 'assistant.knowledge.extract', policy: 'short', retryLimit: 1, expireInSeconds: 120 })
    expect(knowledgeExtractJob.cron).toBeUndefined()
    expect(knowledgeCleanupJob).toMatchObject({ name: 'assistant.knowledge.cleanup', cron: '*/15 * * * *' })
  })

  it('assistant.knowledge.extract: the first run reads the PDF and makes the draft entry; the second changes nothing', async () => {
    const d = await document('extracting')
    const ctx = { db: h.db, clock: h.clock, logger: quiet }
    await knowledgeExtractJob.handler(ctx, { documentId: d.id }, { id: 'j1' })
    const first = await snapshot()
    expect(first).toContain('"status":"ready"')
    expect(first).toContain(`"document_id":"${d.id}"`)
    await knowledgeExtractJob.handler(ctx, { documentId: d.id }, { id: 'j2' })
    expect(await snapshot()).toBe(first)
  })

  it('assistant.knowledge.cleanup: the first run removes the abandoned upload and fails the stuck read; the second changes nothing', async () => {
    const abandoned = await document('pending_upload', { minutesAgo: 20 })
    const fresh = await document('pending_upload', { minutesAgo: 2 })
    await document('extracting', { minutesAgo: 30 })
    const ctx = { db: h.db, clock: h.clock, logger: quiet }
    await knowledgeCleanupJob.handler(ctx, {} as never, { id: 'c1' })
    const first = await snapshot()
    expect(first).not.toContain(abandoned.id)
    expect(first).toContain(fresh.id)
    expect(first).toContain('"error_code":"timeout"')
    expect(await abandoned.storage.head(abandoned.key)).toBeNull()
    await knowledgeCleanupJob.handler(ctx, {} as never, { id: 'c2' })
    expect(await snapshot()).toBe(first)
  })
})
