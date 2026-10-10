// The AI provider factory (ADR 0160). AI_PROVIDER=sim (the default) answers with the simulator and never reaches AWS;
// AI_PROVIDER=bedrock (Claude Sonnet 5.5 through the Converse API) arrives in wave 2.
import type { AiProvider } from '../ports/ai.js'
import type { AiEnvFragment } from './env.js'
import { SimAiProvider } from './sim.js'

export * from './env.js'
export * from './sim.js'

export function createAiProvider(env: Pick<AiEnvFragment, 'AI_PROVIDER' | 'AI_BEDROCK_MODEL_ID'>): AiProvider {
  switch (env.AI_PROVIDER) {
    case 'sim':
      return new SimAiProvider()
    case 'bedrock':
      throw new Error(`AI_PROVIDER=bedrock is not built yet (wave 2); model ${env.AI_BEDROCK_MODEL_ID} cannot be called`)
  }
}
