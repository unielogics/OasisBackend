export interface EmailRequest {
  to: string
  template: string
  vars: Record<string, string | number>
  subject?: string
  replyTo?: string
}

export interface EmailProvider {
  send(req: EmailRequest): Promise<{ id: string }>
}
