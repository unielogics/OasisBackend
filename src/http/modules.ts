// Registry of API modules. A vertical adds one import and one entry here; its routes are mounted under /api/v1 and
// every route must declare config.access (see ./access.ts). Webhook modules are mounted under /hooks.
import type { AppDeps } from '../app.js'
import type { AppInstance } from './types.js'

export type ApiModule = (app: AppInstance, deps: AppDeps) => void | Promise<void>

export const apiModules: ApiModule[] = []
export const hookModules: ApiModule[] = []
