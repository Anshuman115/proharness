import { randomUUID } from 'node:crypto'
import {
  PROVIDER_LABELS,
  type DelegateEvent,
  type DelegateRequest,
  type DelegateUsage,
  type ProviderId,
  type ProviderTestOverrides,
  type ProviderTestResult
} from '@shared/types'
import type { SettingsService } from './settings'

interface StreamChunk {
  text?: string
  reasoning?: string
  usage?: DelegateUsage
}

interface ActiveRequest {
  controller: AbortController
  provider: ProviderId
}

function providerName(provider: ProviderId): string {
  return PROVIDER_LABELS[provider]
}

function extractContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text || '')
        }
        return ''
      })
      .join('')
  }
  return ''
}

function parseUsage(value: unknown): DelegateUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const numberOrNull = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) ? input : null
  return {
    promptTokens: numberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: numberOrNull(usage.completion_tokens ?? usage.output_tokens),
    totalTokens: numberOrNull(usage.total_tokens)
  }
}

export class ProviderService {
  private active = new Map<string, ActiveRequest>()
  private emit: (event: DelegateEvent) => void = () => undefined

  constructor(private readonly settings: SettingsService) {}

  setEmitter(emitter: (event: DelegateEvent) => void): void {
    this.emit = emitter
  }

  getConfigured(provider: ProviderId): boolean {
    return this.settings.providerIsConfigured(provider)
  }

  private async *streamCompletion(
    request: DelegateRequest,
    signal?: AbortSignal,
    overrides: ProviderTestOverrides = {}
  ): AsyncGenerator<StreamChunk> {
    const apiKey = overrides.apiKey?.trim() || this.settings.getProviderApiKey(request.provider)
    if (!apiKey) {
      throw new Error(`${providerName(request.provider)} is not configured. Add an API key in Settings.`)
    }
    const baseUrl = (overrides.baseUrl?.trim() || this.settings.getProviderBaseUrl(request.provider)).replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('The provider base URL must start with http:// or https://.')
    const model = request.model?.trim() || this.settings.getProviderModel(request.provider)
    const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
    const messages: Array<{ role: string; content: string }> = []
    if (request.system?.trim()) messages.push({ role: 'system', content: request.system.trim() })
    messages.push({ role: 'user', content: request.prompt })

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) {
      if (request.provider === 'openai') body.max_completion_tokens = request.maxTokens
      else body.max_tokens = request.maxTokens
    }

    const timeout = AbortSignal.timeout(180_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          accept: 'text/event-stream'
        },
        body: JSON.stringify(body),
        signal: combined
      })
    } catch (error) {
      if (combined.aborted) throw new Error('Delegation cancelled or timed out.')
      throw new Error(`Could not reach ${providerName(request.provider)}: ${(error as Error).message}`)
    }

    if (!response.ok) {
      const preview = (await response.text().catch(() => '')).slice(0, 800)
      throw new Error(
        `${providerName(request.provider)} returned ${response.status}${preview ? `: ${preview}` : ''}`
      )
    }
    if (!response.body) throw new Error(`${providerName(request.provider)} returned an empty response.`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawEvent = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done && !buffer) break
        buffer += done ? `${decoder.decode()}\n` : decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n')
        while (boundary !== -1) {
          const rawLine = buffer.slice(0, boundary).trim()
          buffer = buffer.slice(boundary + 1)
          boundary = buffer.indexOf('\n')
          if (!rawLine || rawLine.startsWith(':') || !rawLine.startsWith('data:')) continue
          const data = rawLine.slice(5).trim()
          if (data === '[DONE]') return
          sawEvent = true
          let payload: Record<string, unknown>
          try {
            payload = JSON.parse(data) as Record<string, unknown>
          } catch {
            continue
          }
          const choices = Array.isArray(payload.choices) ? payload.choices : []
          const choice = (choices[0] || {}) as Record<string, unknown>
          const delta = (choice.delta || {}) as Record<string, unknown>
          const text = extractContent(delta.content ?? choice.text)
          const reasoning = extractContent(delta.reasoning_content ?? delta.reasoning)
          const usage = parseUsage(payload.usage)
          if (text || reasoning) yield { text, reasoning }
          if (usage) yield { usage }
        }
        if (done) break
      }
      if (!sawEvent) {
        throw new Error(`${providerName(request.provider)} did not return a streaming response.`)
      }
    } finally {
      // Closes the connection when the caller stops early or sees [DONE].
      await reader.cancel().catch(() => undefined)
    }
  }

  async complete(
    request: DelegateRequest,
    signal?: AbortSignal,
    overrides?: ProviderTestOverrides
  ): Promise<{ text: string; usage: DelegateUsage | null }> {
    let text = ''
    let usage: DelegateUsage | null = null
    for await (const chunk of this.streamCompletion(request, signal, overrides)) {
      if (chunk.text) text += chunk.text
      if (chunk.usage) usage = chunk.usage
    }
    return { text, usage }
  }

  async start(request: DelegateRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const controller = new AbortController()
    this.active.set(requestId, { controller, provider: request.provider })
    void this.run(requestId, request, controller)
    return { requestId }
  }

  private async run(requestId: string, request: DelegateRequest, controller: AbortController): Promise<void> {
    let text = ''
    let usage: DelegateUsage | null = null
    let model = request.model || this.settings.getProviderModel(request.provider)
    try {
      for await (const chunk of this.streamCompletion(request, controller.signal)) {
        if (chunk.text) {
          text += chunk.text
          this.emit({ type: 'delta', requestId, text: chunk.text })
        }
        if (chunk.reasoning) {
          this.emit({ type: 'delta', requestId, text: '', reasoning: chunk.reasoning })
        }
        if (chunk.usage) usage = chunk.usage
      }
      model = request.model || this.settings.getProviderModel(request.provider)
      this.emit({ type: 'done', requestId, text, model, usage })
    } catch (error) {
      this.emit({
        type: 'error',
        requestId,
        message: controller.signal.aborted ? 'Cancelled.' : (error as Error).message || 'Delegation failed.'
      })
    } finally {
      this.active.delete(requestId)
    }
  }

  cancel(requestId: string): void {
    const active = this.active.get(requestId)
    if (!active) return
    active.controller.abort()
  }

  async test(provider: ProviderId, overrides: ProviderTestOverrides = {}): Promise<ProviderTestResult> {
    const started = Date.now()
    const model = overrides.model?.trim() || undefined
    try {
      const result = await this.complete(
        {
          provider,
          model,
          system: 'You are a connectivity check. Answer with exactly OK.',
          prompt: 'Reply with exactly OK.',
          maxTokens: 256
        },
        AbortSignal.timeout(45_000),
        overrides
      )
      return {
        ok: Boolean(result.text.trim()),
        message: result.text.trim().slice(0, 80) || 'Connected, but the model returned no text.',
        latencyMs: Date.now() - started,
        model: model || this.settings.getProviderModel(provider)
      }
    } catch (error) {
      return {
        ok: false,
        message: (error as Error).message,
        latencyMs: Date.now() - started,
        model: model || this.settings.getProviderModel(provider)
      }
    }
  }

  dispose(): void {
    for (const request of this.active.values()) request.controller.abort()
    this.active.clear()
  }
}
