// tsx scripts/secret-env.ts --get NAME | --keys
//
// The deploy kit's way to read the environment the app reads (src/config/secrets-source.ts): the Secrets Manager secret named by
// OASIS_SECRET_ID, under the process environment.
//   --get NAME   prints the value of NAME to STDOUT with no newline, for capture into a shell variable (deploy/lib/common.sh
//                config_value). Nothing else is printed on stdout; never run it where stdout is logged.
//                Exit 4 when NAME is set nowhere.
//   --keys       prints the key NAMES the secret holds, one per line (no values).
// Exit 2 = usage or the secret could not be read (the reason on stderr, without values); 3 = OASIS_SECRET_ID is not set.
// Credentials: the SDK's default chain, exactly like the services (instance role, or AWS_SHARED_CREDENTIALS_FILE).
import { SECRET_ID_VAR, SecretSourceError, applySecretEnvironment } from '../src/config/secrets-source.js'

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const args = argv.filter((a) => a !== '--')
  const usage = (): number => (err('usage: secret-env.ts --get NAME | --keys'), 2)
  if (!env[SECRET_ID_VAR]?.trim()) {
    err(`${SECRET_ID_VAR} is not set: the environment has no secret`)
    return 3
  }
  if (args[0] === '--keys' && args.length === 1) {
    // read into an empty copy so every key of the secret shows, whatever the process environment sets
    const scratch: NodeJS.ProcessEnv = { [SECRET_ID_VAR]: env[SECRET_ID_VAR], AWS_REGION: env.AWS_REGION }
    const r = await applySecretEnvironment({ env: scratch, log: () => undefined })
    for (const k of r.filled) out(`${k}\n`)
    return 0
  }
  if (args[0] === '--get' && args.length === 2 && /^[A-Z][A-Z0-9_]*$/.test(args[1]!)) {
    const name = args[1]!
    const copy = { ...env }
    await applySecretEnvironment({ env: copy, log: () => undefined })
    const v = copy[name]
    if (v === undefined || v === '') {
      err(`${name} is set neither in the environment nor in the secret ${env[SECRET_ID_VAR]}`)
      return 4
    }
    out(v)
    return 0
  }
  return usage()
}

if (process.argv[1]?.endsWith('secret-env.ts')) {
  main(
    process.argv.slice(2),
    process.env,
    (s) => void process.stdout.write(s),
    (s) => void process.stderr.write(`secret-env: ${s}\n`),
  ).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`secret-env: ${e instanceof SecretSourceError ? e.message : String(e)}\n`)
      process.exit(2)
    },
  )
}
