// Settings → Oasis AI's own routes (ADR 0174): the knowledge and its PDFs (built), and the contracts of the practice chat, the
// corrections and the review of real conversations (501 until the next wave). The section's settings stay in
// src/modules/settings/http/assistant-routes.ts (GET/PUT /settings/assistant).
import type { ApiModule } from '../../../http/modules.js'
import { createStorageProvider } from '../../../integrations/storage/config.js'
import type { ObjectStorage } from '../../../integrations/storage/types.js'
import '../knowledge/problems.js'
import { registerContractRoutes } from './contract-routes.js'
import { registerKnowledgeRoutes } from './knowledge-routes.js'

export interface AssistantModuleOptions {
  /** The object store of the PDFs (tests); default: the environment's (STORAGE_PROVIDER), built on first use. */
  storage?: ObjectStorage
}

export const createAssistantModule =
  (o: AssistantModuleOptions = {}): ApiModule =>
  (app) => {
    let store: ObjectStorage | undefined = o.storage
    const storage = (): ObjectStorage => (store ??= createStorageProvider(app.env, { clock: app.clock }))
    registerKnowledgeRoutes(app, storage)
    registerContractRoutes(app)
  }

export const assistantModule: ApiModule = createAssistantModule()
