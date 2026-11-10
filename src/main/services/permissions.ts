import { randomUUID } from 'node:crypto'
import type {
  PermissionDecision,
  PermissionOutcome,
  PermissionRequest,
  PermissionRisk
} from '@shared/types'

interface PendingPermission {
  request: PermissionRequest
  resolve: (outcome: PermissionOutcome) => void
  timer: NodeJS.Timeout | null
}

type AskInput = Omit<PermissionRequest, 'id' | 'createdAt'>

export function classifyRisk(toolName: string): PermissionRisk {
  if (/^(Bash|BashOutput|KillShell)$/.test(toolName)) return 'high'
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) return 'medium'
  if (toolName.startsWith('mcp__')) return 'medium'
  if (/^(WebFetch|WebSearch)$/.test(toolName)) return 'medium'
  return 'low'
}

export class PermissionBroker {
  private pending = new Map<string, PendingPermission>()
  private requestEmitter: (request: PermissionRequest) => void = () => undefined
  private resolvedEmitter: (requestId: string, allow: boolean) => void = () => undefined

  setEmitters(
    onRequest: (request: PermissionRequest) => void,
    onResolved: (requestId: string, allow: boolean) => void
  ): void {
    this.requestEmitter = onRequest
    this.resolvedEmitter = onResolved
  }

  ask(input: AskInput, signal?: AbortSignal): Promise<PermissionOutcome> {
    if (signal?.aborted) {
      return Promise.resolve({ allow: false, message: 'The operation was cancelled.' })
    }
    const request: PermissionRequest = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now()
    }

    return new Promise<PermissionOutcome>((resolve) => {
      const finish = (outcome: PermissionOutcome): void => {
        const pending = this.pending.get(request.id)
        if (!pending) return
        this.pending.delete(request.id)
        if (pending.timer) clearTimeout(pending.timer)
        signal?.removeEventListener('abort', onAbort)
        pending.resolve(outcome)
        this.resolvedEmitter(request.id, outcome.allow)
      }

      const onAbort = (): void => {
        finish({ allow: false, message: 'The operation was cancelled.' })
      }

      const timer = setTimeout(() => {
        finish({ allow: false, message: 'Permission request timed out after 10 minutes.' })
      }, 10 * 60_000)
      timer.unref()

      this.pending.set(request.id, { request, resolve, timer })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.requestEmitter(request)
    })
  }

  decide(decision: PermissionDecision): void {
    const pending = this.pending.get(decision.requestId)
    if (!pending) return
    const outcome: PermissionOutcome = decision.allow
      ? { allow: true, remember: Boolean(decision.remember) }
      : { allow: false, message: decision.message || 'The user denied this action.' }
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(decision.requestId)
    pending.resolve(outcome)
    this.resolvedEmitter(decision.requestId, outcome.allow)
  }

  denyAll(message: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve({ allow: false, message })
      this.resolvedEmitter(id, false)
    }
    this.pending.clear()
  }

  get count(): number {
    return this.pending.size
  }
}
