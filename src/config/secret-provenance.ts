// Which environment values came from the Secrets Manager secret (src/config/secrets-source.ts), per environment object. The loader
// records each value it fills; validation (src/config/env.ts) asks, for the settings that must come from the secret and from nowhere
// else (PIN_PEPPER in production, ADR 0160). A value counts only while the environment still holds exactly what the secret gave: a
// later override in the process, or a value an env file set before the secret was read (the loader keeps it, so it is never
// recorded), does not. A copy of the environment carries no record: pass secretKeysOf(original) along with it.

const filledBySecret = new WeakMap<object, Map<string, string>>()

/** Records the keys the secret filled into this environment, with the values it filled (kept across later loader runs). */
export function recordSecretFill(env: NodeJS.ProcessEnv, filled: Iterable<string>): void {
  const known = filledBySecret.get(env) ?? new Map<string, string>()
  for (const k of filled) {
    const v = env[k]
    if (v !== undefined) known.set(k, v)
  }
  filledBySecret.set(env, known)
}

/** The keys whose current value in this environment is the one the secret filled. */
export function secretKeysOf(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const known = filledBySecret.get(env)
  if (!known) return new Set()
  return new Set([...known].filter(([k, v]) => env[k] === v).map(([k]) => k).sort())
}
