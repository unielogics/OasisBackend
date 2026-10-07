import { readdirSync } from 'node:fs'
import { envSchema } from '../../src/config/env.js'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsSim, type AwsSimOptions } from '../../scripts/verify-live/sim-aws.js'
import { main, AWS_ITEMS } from '../../scripts/verify-live/aws.js'
import { runVerify, statusOf, type CliRun } from './verify-live-helpers.js'

const runs: CliRun[] = []
const sims: AwsSim[] = []
afterEach(async () => {
  while (runs.length) runs.pop()!.cleanup()
  while (sims.length) await sims.pop()!.stop()
})
const run = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> => {
  const r = await runVerify(main, argv, env)
  runs.push(r)
  return r
}

/** The script in live mode, pointed at an AwsSim we keep hold of so the tests can see what reached "AWS". */
async function live(
  opts: AwsSimOptions = {},
  extraEnv: Record<string, string> = {},
): Promise<{ sim: AwsSim; env: Record<string, string> }> {
  const sim = new AwsSim({
    bucket: 'oasis-live',
    verifiedIdentities: ['oasis.example', 'tester@example.com'],
    cors: { origins: ['https://dashboard.oasis.example'], methods: ['POST', 'GET', 'HEAD'] },
    ...opts,
  })
  await sim.start(4598)
  sims.push(sim)
  return {
    sim,
    env: {
      AWS_ACCESS_KEY_ID: sim.opts.accessKeyId,
      AWS_SECRET_ACCESS_KEY: 'super-secret-key-value',
      AWS_ENDPOINT_URL: sim.url,
      AWS_REGION: 'us-east-1',
      S3_BUCKET: 'oasis-live',
      SES_FROM_ADDRESS: 'no-reply@oasis.example',
      SES_CONFIGURATION_SET: 'oasis-sim',
      PUBLIC_DASHBOARD_URL: 'https://dashboard.oasis.example',
      ...extraEnv,
    },
  }
}

describe('verify:aws against the built-in simulator on port 4592', () => {
  it('passes every item the simulator can answer, including the real SDK presigned-POST round trip', async () => {
    const r = await run(['--sim', '--send', '--to', 'tester@example.com'])
    const s = statusOf(r, 'aws')
    for (const id of [
      'AWS-01',
      'AWS-02',
      'AWS-03',
      'AWS-05',
      'AWS-06',
      'AWS-S1',
      'AWS-S2',
      'AWS-S3',
      'AWS-S4',
      'AWS-S5',
      'AWS-G1',
    ])
      expect([id, s[id]]).toEqual([id, 'PASS'])
    expect(s['AWS-04']).toBe('SKIP')
    expect(Object.keys(s)).toHaveLength(AWS_ITEMS.length)
    expect(r.code).toBe(0)
    expect(r.json('aws').items.find((i) => i.id === 'AWS-S3')!.detail).toMatch(
      /presigned POST accepted; head 70 bytes image\/png; presigned GET returned identical bytes; delete accepted; head after delete is 404/,
    )
    expect(r.out).not.toContain('tester@example.com') // masked
    expect(r.out + r.markdown('aws')).not.toContain('simulator-secret')
  })

  it('reads only without --send: write items are SKIP and say which flag turns them on', async () => {
    const r = await run(['--sim'])
    const s = statusOf(r, 'aws')
    expect(s['AWS-06']).toBe('SKIP')
    expect(s['AWS-S3']).toBe('SKIP')
    expect(s['AWS-G1']).toBe('SKIP')
    expect(s['AWS-01']).toBe('PASS')
    expect(r.code).toBe(0)
  })

  it('--send without --to is refused before anything is contacted', async () => {
    const r = await run(['--sim', '--send'])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/--send needs --to <email>/)
  })
})

describe('verify:aws against an account (live mode over the simulator)', () => {
  it('without --send nothing is written: no email, no object', async () => {
    const { sim, env } = await live()
    const r = await run([], env)
    expect(r.code).toBe(0)
    expect(sim.sentEmails).toEqual([])
    expect(sim.objects.size).toBe(0)
    expect(
      sim.requests.some((q) => q.startsWith('POST') || q.startsWith('PUT') || q.startsWith('DELETE')),
    ).toBe(false)
  })

  it('--send delivers exactly one email and leaves no object behind', async () => {
    const { sim, env } = await live()
    const r = await run(['--send', '--to', 'tester@example.com'], env)
    expect(r.code).toBe(0)
    expect(sim.sentEmails).toHaveLength(1)
    expect(sim.sentEmails[0]).toMatchObject({
      from: 'no-reply@oasis.example',
      to: ['tester@example.com'],
      configurationSet: 'oasis-sim',
    })
    expect(sim.sentEmails[0]!.subject).toMatch(/^\[Alert\] Live verification is working/)
    expect(sim.objects.size).toBe(0)
    expect(sim.requests.filter((q) => q.startsWith('POST /oasis-live')).length).toBe(1)
  })

  it('the SES sandbox: an unverified recipient fails the send and the account item says how to leave the sandbox', async () => {
    const { env } = await live({ sandbox: true })
    const r = await run(['--send', '--to', 'someone@elsewhere.test'], env)
    const s = statusOf(r, 'aws')
    expect(s['AWS-02']).toBe('FAIL')
    expect(s['AWS-06']).toBe('FAIL')
    expect(r.out).toMatch(/put-account-details --production-access-enabled/)
    expect(r.out).toMatch(/recipient must be a verified identity/)
    expect(r.code).toBe(1)
    // the mailbox simulator works in the sandbox
    const ok = await run(['--send', '--to', 'success@simulator.amazonses.com'], env)
    expect(statusOf(ok, 'aws')['AWS-06']).toBe('PASS')
  })

  it('lists each missing IAM action precisely: SendEmail and DeleteObject', async () => {
    const { env, sim } = await live({ deny: ['ses:SendEmail', 's3:DeleteObject'] })
    const r = await run(['--send', '--to', 'tester@example.com'], env)
    const s = statusOf(r, 'aws')
    expect(s['AWS-05']).toBe('FAIL')
    expect(s['AWS-S3']).toBe('FAIL')
    expect(s['AWS-G1']).toBe('FAIL')
    const g1 = r.json('aws').items.find((i) => i.id === 'AWS-G1')!
    expect(g1.detail).toBe('2 missing: ses:SendEmail, s3:DeleteObject')
    expect(r.out).toMatch(
      /fix: Add to the app role's policy: ses:SendEmail on .*; s3:DeleteObject on arn:aws:s3:::oasis-live\/verify\/\*/,
    )
    expect(sim.sentEmails).toHaveLength(0)
    // the failed delete leaves the test object, and the script says so instead of pretending to have cleaned up
    expect(sim.objects.size).toBe(1)
    expect(r.json('aws').notes.join('\n')).toMatch(/COULD NOT delete the test object verify\//)
  })

  it('missing s3:ListBucket is found by the 403-instead-of-404 rule', async () => {
    const { env } = await live({ deny: ['s3:ListBucket'] })
    const r = await run(['--send', '--to', 'tester@example.com'], env)
    expect(r.json('aws').items.find((i) => i.id === 'AWS-G1')!.detail).toBe('1 missing: s3:ListBucket')
    expect(statusOf(r, 'aws')['AWS-S1']).toBe('SKIP')
    expect(r.out).toMatch(/Without s3:ListBucket a missing key reads as 403, not 404/)
  })

  it('misconfigured bucket and identity: DKIM pending, CORS missing, Block Public Access partly off, no lifecycle', async () => {
    const { env } = await live({
      dkimStatus: 'PENDING',
      cors: null,
      publicAccessBlock: {
        BlockPublicAcls: true,
        IgnorePublicAcls: false,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
      lifecycle: false,
      tlsOnlyPolicy: false,
      encryption: null,
    })
    const r = await run([], env)
    const s = statusOf(r, 'aws')
    expect(s['AWS-01']).toBe('FAIL')
    expect(s['AWS-S2']).toBe('FAIL')
    expect(s['AWS-S1']).toBe('FAIL')
    expect(s['AWS-S4']).toBe('SKIP')
    expect(s['AWS-S5']).toBe('FAIL')
    const items = Object.fromEntries(r.json('aws').items.map((i) => [i.id, i.detail]))
    expect(items['AWS-S1']).toMatch(/Block Public Access off for IgnorePublicAcls/)
    expect(items['AWS-S1']).toMatch(/no bucket policy/)
    expect(items['AWS-S2']).toMatch(/no CORS configuration/)
  })

  it('a CORS rule for another origin does not satisfy the dashboard', async () => {
    const { env } = await live({ cors: { origins: ['https://other.example'], methods: ['POST'] } })
    const r = await run([], env)
    expect(statusOf(r, 'aws')['AWS-S2']).toBe('FAIL')
    expect(r.json('aws').items.find((i) => i.id === 'AWS-S2')!.detail).toMatch(/does NOT match/)
  })

  it('read permissions the identity lacks become SKIP naming the action, not FAIL', async () => {
    const { env } = await live({ deny: ['ses:GetAccount', 's3:GetBucketCORS', 's3:GetBucketPolicy'] })
    const r = await run([], env)
    const s = statusOf(r, 'aws')
    expect(s['AWS-02']).toBe('SKIP')
    expect(s['AWS-S2']).toBe('SKIP')
    const items = Object.fromEntries(r.json('aws').items.map((i) => [i.id, i.detail]))
    expect(items['AWS-02']).toMatch(/ses:GetAccount/)
    expect(r.json('aws').notes.join('\n')).toMatch(
      /ses:GetAccount, s3:GetBucketCORS, s3:GetBucketPolicy|s3:GetBucketCORS/,
    )
    expect(r.code).toBe(0)
  })

  it('a prefix or encryption setting that src/config/env.ts does not declare is reported as ignored by the app, and the round trip uses what the app will use', async () => {
    const { env, sim } = await live()
    const declared = Object.keys(
      (envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema.shape,
    )
    const r = await run(['--send', '--to', 'tester@example.com'], { ...env, S3_KEY_PREFIX: 'prod/' })
    const s5 = r.json('aws').items.find((i) => i.id === 'AWS-S5')!
    if (declared.includes('S3_KEY_PREFIX')) {
      expect(s5.status).toBe('PASS')
    } else {
      expect(s5.status).toBe('FAIL')
      expect(s5.detail).toMatch(
        /S3_KEY_PREFIX is set but src\/config\/env.ts does not declare it, so the app ignores it/,
      )
      // the app would write at the bucket root, so that is where the check wrote (and cleaned up) too
      expect(sim.requests.some((q) => q.includes('/oasis-live/prod/verify'))).toBe(false)
    }
    expect(sim.objects.size).toBe(0)
  })

  it('a bucket in another region or a wrong name is a FAIL with the create command', async () => {
    const { env } = await live()
    const r = await run([], { ...env, S3_BUCKET: 'no-such-bucket' })
    expect(statusOf(r, 'aws')['AWS-S1']).toBe('FAIL')
    expect(r.out).toMatch(/aws s3api create-bucket --bucket no-such-bucket/)
  })

  it('rejected credentials fail loudly and the secret key is never printed', async () => {
    const { env } = await live()
    const r = await run([], { ...env, AWS_ACCESS_KEY_ID: 'AKIAWRONG000000000' })
    expect(r.code).toBe(1)
    expect(statusOf(r, 'aws')['AWS-01']).toBe('FAIL')
    expect(r.out).toMatch(/fix: AWS rejected the credentials/)
    expect(r.out + r.markdown('aws')).not.toContain('super-secret-key-value')
  })
})

describe('verify:aws without credentials', () => {
  it('exits 2 and lists exactly what is missing, without contacting AWS or writing a report', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.out).toContain('AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY')
    expect(r.out).toContain('SES_FROM_ADDRESS')
    expect(r.out).toContain('S3_BUCKET')
    expect(r.out).toMatch(/Nothing probes instance metadata unless you pass --instance-profile/)
    expect(readdirSync(r.outDir)).toEqual([])
  })

  it('--only ses drops the S3 variables from the list', async () => {
    const r = await run(['--only', 'ses'])
    expect(r.out).toContain('SES_FROM_ADDRESS')
    expect(r.out).not.toMatch(/- S3_BUCKET/)
  })

  it('--instance-profile counts as explicit consent for the instance role', async () => {
    const r = await run(['--instance-profile'], { SES_FROM_ADDRESS: 'x@y.test' })
    expect(r.out).not.toContain('AWS_ACCESS_KEY_ID')
    expect(r.out).toContain('S3_BUCKET')
  })
})
