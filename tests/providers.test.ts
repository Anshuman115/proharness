import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderService } from '../src/main/services/providers'
import type { SettingsService } from '../src/main/services/settings'

let server: Server
let baseUrl = ''
let respond: (body: string) => { status: number; body: string } = () => ({ status: 200, body: '' })
let lastBody = ''

function settings(key: string | null = 'test-key'): SettingsService {
  return {
    getProviderApiKey: () => key ?? undefined,
    getProviderBaseUrl: () => baseUrl,
    getProviderModel: () => 'saved-model',
    providerIsConfigured: () => Boolean(key)
  } as unknown as SettingsService
}

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      lastBody = body
      const reply = respond(body)
      res.writeHead(reply.status, { 'content-type': 'text/event-stream' })
      res.end(reply.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('ProviderService', () => {
  it('assembles streamed content, including a final event without a trailing newline', async () => {
    respond = () => ({
      status: 200,
      body:
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
        ': keep-alive\n' +
        'data: {"choices":[{"delta":{"content":"lo"}}]}'
    })
    const result = await new ProviderService(settings()).complete({ provider: 'deepseek', prompt: 'hi' })
    expect(result.text).toBe('Hello')
    expect(JSON.parse(lastBody)).toMatchObject({ model: 'saved-model', stream: true })
  })

  it('surfaces HTTP errors with the provider name', async () => {
    respond = () => ({ status: 401, body: 'bad key' })
    await expect(new ProviderService(settings()).complete({ provider: 'kimi', prompt: 'hi' })).rejects.toThrow(
      /Kimi returned 401: bad key/
    )
  })

  it('refuses to call an unconfigured provider', async () => {
    await expect(
      new ProviderService(settings(null)).complete({ provider: 'openai', prompt: 'hi' })
    ).rejects.toThrow(/not configured/)
  })

  it('tests unsaved settings from the form', async () => {
    respond = () => ({ status: 200, body: 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n' })
    const result = await new ProviderService(settings(null)).test('openai', {
      baseUrl,
      model: 'draft-model',
      apiKey: 'draft-key'
    })
    expect(result.ok).toBe(true)
    expect(JSON.parse(lastBody).model).toBe('draft-model')
  })

  it('reports cancellation as an error event', async () => {
    respond = () => ({ status: 200, body: '' })
    const service = new ProviderService(settings())
    const events: string[] = []
    service.setEmitter((event) => events.push(event.type === 'error' ? event.message : event.type))
    const { requestId } = await service.start({ provider: 'deepseek', prompt: 'hi' })
    service.cancel(requestId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(events).toContain('Cancelled.')
  })
})
