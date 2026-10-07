import { S3Client } from '@aws-sdk/client-s3'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { mockClient } from 'aws-sdk-client-mock'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface CliRun {
  code: number
  lines: string[]
  out: string
  outDir: string
  json(integration: string): {
    result: string
    summary: { pass: number; fail: number; skip: number }
    mode: string
    items: Array<{ id: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }>
    notes: string[]
  }
  markdown(integration: string): string
  cleanup(): void
}

/** Runs a verify-live `main(argv, env, log)` into a throwaway report directory and returns what it printed and wrote. */
export async function runVerify(
  main: (
    argv: string[],
    env: Record<string, string | undefined>,
    log: (l: string) => void,
  ) => Promise<number>,
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<CliRun> {
  // The suite runs every file in one process, and the email and storage tests mock the AWS clients' send(); the live checks need the real one.
  mockClient(SESv2Client).restore()
  mockClient(S3Client).restore()
  const outDir = mkdtempSync(path.join(tmpdir(), 'oasis-verify-'))
  const lines: string[] = []
  const code = await main([...argv, '--out-dir', outDir], env, (l) => lines.push(l))
  const day = new Date().toISOString().slice(0, 10)
  return {
    code,
    lines,
    out: lines.join('\n'),
    outDir,
    json: (i) => JSON.parse(readFileSync(path.join(outDir, `${day}-${i}.json`), 'utf8')),
    markdown: (i) => readFileSync(path.join(outDir, `${day}-${i}.md`), 'utf8'),
    cleanup: () => rmSync(outDir, { recursive: true, force: true }),
  }
}

export const statusOf = (run: CliRun, integration: string): Record<string, string> =>
  Object.fromEntries(run.json(integration).items.map((i) => [i.id, i.status]))
