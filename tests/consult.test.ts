import { describe, expect, it, vi } from 'vitest'
import type { TurnResult } from '../src/main/omp/agent'
import type { AgentFactory } from '../src/main/services/agents'
import { ConsultService } from '../src/main/services/consult'
import type { GitService } from '../src/main/services/git'
import { WorkspaceGate } from '../src/main/services/workspace-gate'
import type { OmpAgent } from '../src/main/omp/agent'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

function fakeAgent(closeGate: Promise<void>): OmpAgent {
  return {
    start: vi.fn(async () => undefined),
    runTurn: vi.fn(
      (_prompt: string, signal: AbortSignal) =>
        new Promise<TurnResult>((resolve) => {
          const finish = (): void => resolve({ status: 'aborted', error: null, text: '', costUsd: 0 })
          if (signal.aborted) finish()
          else signal.addEventListener('abort', finish, { once: true })
        })
    ),
    close: vi.fn(async () => {
      await closeGate
    })
  } as unknown as OmpAgent
}

describe('ConsultService disposal', () => {
  it('cancels the run and waits for the reviewer agent to close', async () => {
    const gate = new WorkspaceGate()
    const closeGate = deferred<void>()
    const agent = fakeAgent(closeGate.promise)
    const reviewer = vi.fn(async () => agent)
    const consult = new ConsultService(
      { reviewer } as unknown as Pick<AgentFactory, 'reviewer'>,
      {} as GitService,
      gate
    )
    await consult.start({ model: 'vendor/model', prompt: 'Check this.', includeDiff: false })
    const disposing = consult.dispose()
    await tick()
    let settled = false
    void disposing.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    closeGate.resolve()
    await disposing
    expect(agent.close).toHaveBeenCalledTimes(1)
  })


  it('closes a starting reviewer on dispose without waiting for start', async () => {
    const gate = new WorkspaceGate()
    const closeGate = deferred<void>()
    let rejectStart!: (error: Error) => void
    const agent = {
      start: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStart = reject
          })
      ),
      runTurn: vi.fn(),
      close: vi.fn(async () => {
        rejectStart?.(new Error('closed'))
        await closeGate.promise
      })
    } as unknown as OmpAgent
    const reviewer = vi.fn(async () => agent)
    const consult = new ConsultService(
      { reviewer } as unknown as Pick<AgentFactory, 'reviewer'>,
      {} as GitService,
      gate
    )
    await consult.start({ model: 'vendor/model', prompt: 'Check this.', includeDiff: false })
    await tick()
    const disposing = consult.dispose()
    let settled = false
    void disposing.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    closeGate.resolve()
    await disposing
    expect(agent.close).toHaveBeenCalledTimes(1)
    expect(agent.runTurn).not.toHaveBeenCalled()
  })

  it('rejects a start while a workspace transition is busy', async () => {
    const gate = new WorkspaceGate()
    const reviewer = vi.fn()
    const consult = new ConsultService(
      { reviewer } as unknown as Pick<AgentFactory, 'reviewer'>,
      {} as GitService,
      gate
    )
    gate.begin()
    try {
      await expect(
        consult.start({ model: 'vendor/model', prompt: 'Check this.', includeDiff: false })
      ).rejects.toThrow(/workspace is changing/)
      expect(reviewer).not.toHaveBeenCalled()
    } finally {
      gate.end()
    }
  })
})
