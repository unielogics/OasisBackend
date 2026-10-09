// A Secrets Manager endpoint on 127.0.0.1 that speaks the service's JSON protocol for GetSecretValue, so a real program (tsx scripts/...,
// a deploy script) can be run with OASIS_SECRET_ID and AWS_ENDPOINT_URL_SECRETS_MANAGER pointing here: the real SDK, credential
// resolution from the environment, the real loader. Nothing leaves the machine.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export class FakeSecretsHttp {
  readonly secrets = new Map<string, string>()
  readonly requests: Array<{ target: string; secretId: string }> = []
  private server?: Server

  /** Starts the server; returns the environment a child process needs (never real credentials, never instance metadata). */
  async start(): Promise<Record<string, string>> {
    this.server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        const target = String(req.headers['x-amz-target'] ?? '')
        const input = (body ? JSON.parse(body) : {}) as { SecretId?: string }
        this.requests.push({ target, secretId: String(input.SecretId) })
        const send = (code: number, doc: object): void => {
          res.writeHead(code, { 'content-type': 'application/x-amz-json-1.1' })
          res.end(JSON.stringify(doc))
        }
        if (target !== 'secretsmanager.GetSecretValue') return send(400, { __type: 'InvalidRequestException', message: `not modelled: ${target}` })
        const value = this.secrets.get(String(input.SecretId))
        if (value === undefined) return send(400, { __type: 'ResourceNotFoundException', message: "Secrets Manager can't find the specified secret." })
        if (value === 'DENY')
          return send(400, { __type: 'AccessDeniedException', message: `User: arn:aws:sts::123456789012:assumed-role/oasis-app-role/i-0abc is not authorized to perform: secretsmanager:GetSecretValue on resource: ${String(input.SecretId)}` })
        send(200, { ARN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${String(input.SecretId)}-AbCdEf`, Name: input.SecretId, SecretString: value, VersionId: 'v1' })
      })
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    const port = (this.server!.address() as AddressInfo).port
    return {
      AWS_ENDPOINT_URL_SECRETS_MANAGER: `http://127.0.0.1:${port}`,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKE0000',
      AWS_SECRET_ACCESS_KEY: 'fake-secret-access-key-for-the-local-endpoint',
      AWS_EC2_METADATA_DISABLED: 'true',
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }
}
