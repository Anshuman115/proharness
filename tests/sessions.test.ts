import { describe, expect, it, vi } from 'vitest'
import type { OmpAgent } from '../src/main/omp/agent'
import type { AgentFactory } from '../src/main/services/agents'
import type { WorkspaceHost } from '../src/main/host/host'
import { LocalHost } from '../src/main/host/local'
import { SessionManager } from '../src/main/services/sessions'
import { WorkspaceGate } from '../src/main/services/workspace-gate'
import type { SettingsService } from '../src/main/services/settings'
import type { UiBroker } from '../src/main/services/ui-broker'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

function fakeAgent(): OmpAgent & { close: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    switchSession: vi.fn(async () => undefined)
  } as unknown as OmpAgent & { close: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }
}

function build(chat: () => Promise<OmpAgent>, gate?: WorkspaceGate, host: WorkspaceHost = new LocalHost()): SessionManager {
  const settings = { workspacePath: '' } as unknown as SettingsService
  return new SessionManager(
    settings,
    { chat } as unknown as Pick<AgentFactory, 'chat'>,
    { cancelOrigin: vi.fn() } as unknown as UiBroker,
    () => host,
    gate
  )
}

describe('SessionManager pending creates', () => {
  it('cancels a create waiting on the agent factory when the tab is closed', async () => {
    const pending = deferred<OmpAgent>()
    const chat = vi.fn(() => pending.promise)
    const sessions = build(chat)
    const creating = sessions.create({ tabId: 'tab-1', title: 'New session' })
    const expectation = expect(creating).rejects.toThrow(/cancelled/)
    await sessions.close('tab-1')
    const agent = fakeAgent()
    pending.resolve(agent)
    await expectation
    expect(chat).toHaveBeenCalledTimes(1)
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it('lets the latest pending create for a tab win and closes the unused agent', async () => {
    const first = deferred<OmpAgent>()
    const second = deferred<OmpAgent>()
    const chat = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const sessions = build(chat)
    const firstCreate = sessions.create({ tabId: 'tab-2', title: 'First' })
    const firstExpectation = expect(firstCreate).rejects.toThrow(/cancelled/)
    const secondCreate = sessions.create({ tabId: 'tab-2', title: 'Second' })

    const firstAgent = fakeAgent()
    first.resolve(firstAgent)
    await firstExpectation
    expect(firstAgent.close).toHaveBeenCalledTimes(1)

    const secondAgent = fakeAgent()
    second.resolve(secondAgent)
    await secondCreate
    expect(chat).toHaveBeenCalledTimes(2)
    expect(secondAgent.close).not.toHaveBeenCalled()

    await sessions.close('tab-2')
    expect(secondAgent.close).toHaveBeenCalledTimes(1)
  })


  it('rejects a create while a workspace transition is busy', async () => {
    const chat = vi.fn()
    const gate = new WorkspaceGate()
    gate.begin()
    try {
      await expect(build(chat, gate).create({ tabId: 'tab-gate', title: 'Gate' })).rejects.toThrow(
        /workspace is changing/
      )
      expect(chat).not.toHaveBeenCalled()
    } finally {
      gate.end()
    }
  })

  it('propagates a session-file read failure on resume', async () => {
    const host = {
      readFile: vi.fn(async () => {
        throw new Error('ssh connection dropped')
      })
    } as unknown as WorkspaceHost
    await expect(build(vi.fn(), undefined, host).resume('tab-4', '/sessions/x.jsonl')).rejects.toThrow(
      /ssh connection dropped/
    )
  })

  it('closes a created agent when the workspace changes during setup', async () => {
    const pending = deferred<OmpAgent>()
    const chat = vi.fn(() => pending.promise)
    const sessions = build(chat)
    const creating = sessions.create({ tabId: 'tab-3', title: 'New session' })
    const expectation = expect(creating).rejects.toThrow(/workspace changed/)
    await sessions.dispose()
    const agent = fakeAgent()
    pending.resolve(agent)
    await expectation
    expect(agent.close).toHaveBeenCalledTimes(1)
  })
})
