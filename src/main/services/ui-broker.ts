import { randomUUID } from 'node:crypto'
import type { UiRequest, UiResponse } from '@shared/types'

type AskInput = Omit<UiRequest, 'id' | 'createdAt'>

export type UiAnswer =
  | { kind: 'value'; value: string }
  | { kind: 'confirmed'; confirmed: boolean }
  | { kind: 'cancelled' }

interface Pending {
  request: UiRequest
  resolve: (answer: UiAnswer) => void
}

/**
 * Routes omp dialogs (tool approvals, the `ask` tool, extension prompts) from
 * any omp process to the renderer and back.
 */
export class UiBroker {
  private pending = new Map<string, Pending>()
  private onRequest: (request: UiRequest) => void = () => undefined
  private onResolved: (requestId: string) => void = () => undefined

  setEmitters(onRequest: (request: UiRequest) => void, onResolved: (requestId: string) => void): void {
    this.onRequest = onRequest
    this.onResolved = onResolved
  }

  ask(input: AskInput, signal?: AbortSignal): { id: string; answer: Promise<UiAnswer> } {
    const request: UiRequest = { ...input, id: randomUUID(), createdAt: Date.now() }
    const answer = new Promise<UiAnswer>((resolve) => {
      if (signal?.aborted) {
        resolve({ kind: 'cancelled' })
        return
      }
      const onAbort = (): void => this.cancel(request.id)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(request.id, {
        request,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        }
      })
      this.onRequest(request)
    })
    return { id: request.id, answer }
  }

  respond(response: UiResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    if ('value' in response) pending.resolve({ kind: 'value', value: response.value })
    else if ('confirmed' in response) pending.resolve({ kind: 'confirmed', confirmed: response.confirmed })
    else pending.resolve({ kind: 'cancelled' })
    this.onResolved(response.requestId)
  }

  cancel(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    pending.resolve({ kind: 'cancelled' })
    this.onResolved(requestId)
  }

  cancelOrigin(originId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.originId === originId) this.cancel(id)
    }
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id)
  }

  list(): UiRequest[] {
    return [...this.pending.values()].map((pending) => pending.request)
  }
}
