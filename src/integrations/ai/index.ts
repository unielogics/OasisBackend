// The AI provider factory (ADR 0160). AI_PROVIDER=sim (the default) answers with the simulator and never reaches AWS;
// AI_PROVIDER=bedrock calls the Claude model of AI_BEDROCK_MODEL_ID (Sonnet 4.6 for now, Sonnet 5.5 once its quota is raised;
// models.ts) through Amazon Bedrock's Converse API with the default credential chain (the
// instance role in production). Building a provider contacts nothing: the first call does.
import type { AiProvider } from '../ports/ai.js'
import { BedrockProvider, createBedrockClient, type BedrockProviderOptions } from './bedrock.js'
import type { AiEnvFragment } from './env.js'
import { SimAiProvider } from './sim.js'

export * from './env.js'
export * from './sim.js'
export * from './bedrock.js'
export * from './cost.js'
export * from './models.js'

export type AiProviderEnv = Pick<AiEnvFragment, 'AI_PROVIDER' | 'AI_BEDROCK_MODEL_ID'> &
  Partial<Pick<AiEnvFragment, 'AI_BEDROCK_REGION' | 'AI_TIMEOUT_MS' | 'AI_EFFORT' | 'AI_BEDROCK_EFFORT_MODE'>>

export interface AiProviderDeps {
  /** Replaces the Bedrock runtime client (tests, the verify-live simulator). */
  bedrockClient?: BedrockProviderOptions['client']
}

export function createAiProvider(env: AiProviderEnv, deps: AiProviderDeps = {}): AiProvider {
  switch (env.AI_PROVIDER) {
    case 'sim':
      return new SimAiProvider()
    case 'bedrock':
      return new BedrockProvider({
        client: deps.bedrockClient ?? createBedrockClient({ region: env.AI_BEDROCK_REGION ?? 'us-east-1' }),
        modelId: env.AI_BEDROCK_MODEL_ID,
        timeoutMs: env.AI_TIMEOUT_MS ?? 20_000,
        effortMode: env.AI_BEDROCK_EFFORT_MODE ?? 'off',
        ...(env.AI_EFFORT ? { defaultEffort: env.AI_EFFORT } : {}),
      })
  }
}
