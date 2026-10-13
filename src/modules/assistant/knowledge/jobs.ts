// pg-boss jobs of the assistant's knowledge (ADR 0174 §2), registered in src/platform/job-registry.ts:
//   assistant.knowledge.extract   queue-only (short policy, singleton key = the document): reads one uploaded PDF in a worker thread
//                                 and stores its cleaned text and its draft entry, or fails it with a plain reason. Enqueued by
//                                 POST /assistant/knowledge/documents/:id/complete and .../extract (retry) after their commit.
//   assistant.knowledge.cleanup   every 15 minutes: abandoned uploads and their objects, extractions stuck over 10 minutes (failed
//                                 as timeout, the owner can retry), objects of deleted documents removed again.
// Neither depends on AI_ENABLED: nothing reaches a client, and with no upload they find nothing to do.
import { loadEnv } from '../../../config/env.js'
import { createStorageProvider } from '../../../integrations/storage/config.js'
import { createIdGenerator } from '../../../platform/ids.js'
import type { JobDefinition } from '../../../platform/jobs.js'
import { CLEANUP_JOB, cleanupDocuments, EXTRACT_JOB, extractDocument } from './documents.js'

export interface ExtractData {
  documentId: string
}

export const knowledgeExtractJob: JobDefinition<ExtractData> = {
  name: EXTRACT_JOB,
  policy: 'short',
  // a thrown error (the database, the store) is tried once more; the file's own problems are results, not errors
  retryLimit: 1,
  // the read stops at 30 s (the worker is terminated); a job active after this died with its worker
  expireInSeconds: 120,
  async handler(ctx, data) {
    if (typeof data?.documentId !== 'string') return
    const env = loadEnv()
    const r = await extractDocument(
      {
        db: ctx.db,
        storage: createStorageProvider(env, { clock: ctx.clock }),
        newId: createIdGenerator(ctx.clock),
        now: () => ctx.clock.now(),
        shopNumbers: [env.BUSINESS_TEXT_NUMBER, env.BUSINESS_PHONE],
      },
      data.documentId,
    )
    if (r !== 'skipped') ctx.logger.info({ documentId: data.documentId, result: r }, 'knowledge document read')
  },
}

export const knowledgeCleanupJob: JobDefinition = {
  name: CLEANUP_JOB,
  cron: '*/15 * * * *',
  policy: 'stately',
  async handler(ctx) {
    const r = await cleanupDocuments(ctx.db, createStorageProvider(loadEnv(), { clock: ctx.clock }), ctx.clock.now())
    if (r.abandoned || r.stuck || r.objects) ctx.logger.info(r, 'knowledge documents cleaned up')
  },
}

export const knowledgeJobs: readonly JobDefinition<never>[] = [knowledgeExtractJob as JobDefinition<never>, knowledgeCleanupJob as JobDefinition<never>]
