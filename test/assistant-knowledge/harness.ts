// The knowledge suites' harness (ADR 0174): the Settings harness (the real app, sessions, permissions, a frozen clock, captured
// jobs) with the Oasis AI module mounted over a filesystem object store in a temporary directory.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FsStorage } from '../../src/integrations/storage/fs-provider.js'
import { createAssistantModule } from '../../src/modules/assistant/http/module.js'
import { FixedClock } from '../../src/platform/clock.js'
import { useSettingsHarness, type SettingsHarness } from '../settings-http/harness.js'

export interface KnowledgeHarness extends SettingsHarness {
  readonly storage: FsStorage
}

export function useKnowledgeHarness(o: { env?: Record<string, string> } = {}): KnowledgeHarness {
  const storage = new FsStorage({
    root: mkdtempSync(path.join(tmpdir(), 'oasis-kb-')),
    clock: new FixedClock('2026-06-13T10:36:00-04:00'),
    secret: 'knowledge-test-signing-secret',
    baseUrl: 'http://localhost:4000/dev-storage',
  })
  const h = useSettingsHarness({ env: o.env, extraModules: [createAssistantModule({ storage })] })
  return Object.assign(Object.create(h) as SettingsHarness, { storage }) as KnowledgeHarness
}
