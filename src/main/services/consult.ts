import { randomUUID } from 'node:crypto'
import type { ConsultEvent, ConsultRequest } from '@shared/types'
import type { AgentFactory } from './agents'
import type { GitService } from './git'

/**
 * One-shot second opinion from any omp model. The consulted model can read
 * the repository but cannot change it.
 */
export class ConsultService {
  private running = new Map<string, AbortController>()
  private emit: (event: ConsultEvent) => void = () => undefined

  constructor(
    private readonly agents: AgentFactory,
    private readonly git: GitService
  ) {}

  setEmitter(emitter: (event: ConsultEvent) => void): void {
    this.emit = emitter
  }

  async start(request: ConsultRequest): Promise<{ requestId: string }> {
    if (!request.model.trim()) throw new Error('Choose a model to consult.')
    if (!request.prompt.trim()) throw new Error('Write a question first.')
    const requestId = randomUUID()
    const controller = new AbortController()
    this.running.set(requestId, controller)
    void this.run(requestId, request, controller.signal)
    return { requestId }
  }

  private async run(requestId: string, request: ConsultRequest, signal: AbortSignal): Promise<void> {
    let prompt = [
      'You are giving a second opinion to an engineer. You can read files in this repository but must not modify anything.',
      'Be concrete and concise. Do not claim to have changed files.',
      '',
      request.prompt.trim()
    ].join('\n')
    try {
      if (request.includeDiff) {
        const { summary, diff, truncated } = await this.git.reviewDiff(120_000)
        prompt += summary.files.length
          ? `\n\nCurrent working-tree diff${truncated ? ' (truncated)' : ''}:\n\`\`\`diff\n${diff}\n\`\`\``
          : '\n\n(The working tree has no changes.)'
      }
      const agent = await this.agents.reviewer({
        model: request.model,
        label: 'Consult',
        onEvent: (event) => {
          if (event.type === 'delta') this.emit({ type: 'delta', requestId, text: event.text })
          if (event.type === 'block' && event.block.type === 'thinking' && event.block.text) {
            this.emit({ type: 'thinking', requestId, text: event.block.text })
          }
          if (event.type === 'block' && event.block.type === 'tool') {
            this.emit({ type: 'tool', requestId, label: `${event.block.name}${event.block.intent ? ` · ${event.block.intent}` : ''}` })
          }
        }
      })
      try {
        await agent.start()
        const result = await agent.runTurn(prompt, signal)
        if (signal.aborted || result.status === 'aborted') {
          this.emit({ type: 'error', requestId, message: 'Cancelled.' })
        } else if (result.status === 'error') {
          this.emit({ type: 'error', requestId, message: result.error || 'The model request failed.' })
        } else {
          this.emit({ type: 'done', requestId, text: result.text, costUsd: result.costUsd })
        }
      } finally {
        await agent.close().catch(() => undefined)
      }
    } catch (error) {
      this.emit({ type: 'error', requestId, message: (error as Error).message })
    } finally {
      this.running.delete(requestId)
    }
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort()
  }

  dispose(): void {
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }
}
