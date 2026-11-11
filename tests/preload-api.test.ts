import { describe, expect, it, vi } from 'vitest'
import { createApi, type IpcRendererLike } from '../src/preload/api'
import type { PublicSettings, SessionEvent, TerminalDataEvent } from '../src/shared/types'

type Listener = (event: unknown, ...args: unknown[]) => void

function fakeIpc(): {
  ipc: IpcRendererLike
  invokes: Array<{ channel: string; args: unknown[] }>
  sends: Array<{ channel: string; args: unknown[] }>
  listeners: Map<string, Listener[]>
  emit: (channel: string, ...args: unknown[]) => void
} {
  const invokes: Array<{ channel: string; args: unknown[] }> = []
  const sends: Array<{ channel: string; args: unknown[] }> = []
  const listeners = new Map<string, Listener[]>()
  const ipc: IpcRendererLike = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args })
      return { ok: true }
    }),
    send: vi.fn((channel: string, ...args: unknown[]) => {
      sends.push({ channel, args })
    }),
    on: vi.fn((channel: string, listener: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) || []), listener])
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.set(channel, (listeners.get(channel) || []).filter((item) => item !== listener))
    })
  }
  return {
    ipc,
    invokes,
    sends,
    listeners,
    emit: (channel, ...args) => {
      for (const listener of [...(listeners.get(channel) || [])]) listener({ fakeEvent: true }, ...args)
    }
  }
}

describe('createApi', () => {
  it('sends invoke leaves on the exact namespace:method channel with their args', async () => {
    const ctx = fakeIpc()
    const api = createApi(ctx.ipc)
    const patch = { chatApproval: 'yolo' as const }
    await expect(api.settings.update(patch)).resolves.toEqual({ ok: true })
    expect(ctx.invokes).toEqual([{ channel: 'settings:update', args: [patch] }])
    await api.bootstrap()
    expect(ctx.invokes[1]).toEqual({ channel: 'app:bootstrap', args: [] })
    await api.sessions.newConversation('tab-1')
    expect(ctx.invokes[2]).toEqual({ channel: 'sessions:newConversation', args: ['tab-1'] })
    await api.git.fileDiff('src/a.ts')
    expect(ctx.invokes[3]).toEqual({ channel: 'git:fileDiff', args: ['src/a.ts'] })
    await api.loginShare.status()
    expect(ctx.invokes[4]).toEqual({ channel: 'loginShare:status', args: [] })
    await api.loop.state()
    expect(ctx.invokes[5]).toEqual({ channel: 'loop:state', args: [] })
  })

  it('keeps send leaves synchronous and on ipc.send', () => {
    const ctx = fakeIpc()
    const api = createApi(ctx.ipc)
    expect(api.terminal.write('tab-1', 'ls\n')).toBeUndefined()
    expect(api.terminal.resize('tab-1', 100, 30)).toBeUndefined()
    expect(ctx.sends).toEqual([
      { channel: 'terminal:write', args: ['tab-1', 'ls\n'] },
      { channel: 'terminal:resize', args: ['tab-1', 100, 30] }
    ])
    expect(ctx.invokes).toEqual([])
  })

  it('strips the Electron event and passes payload only', () => {
    const ctx = fakeIpc()
    const api = createApi(ctx.ipc)
    const settings: PublicSettings[] = []
    const sessions: Array<[string, SessionEvent]> = []
    const data: TerminalDataEvent[] = []
    api.settings.onChanged((value) => settings.push(value))
    api.sessions.onEvent((tabId, event) => sessions.push([tabId, event]))
    api.terminal.onData((event) => data.push(event))
    const payload = { workspacePath: '/tmp/x' } as PublicSettings
    const event = { type: 'status', status: 'idle' } as SessionEvent
    ctx.emit('settings:onChanged', payload)
    ctx.emit('sessions:onEvent', 'tab-1', event)
    ctx.emit('terminal:onData', { id: 'tab-1', data: 'hi' })
    expect(settings).toEqual([payload])
    expect(sessions).toEqual([['tab-1', event]])
    expect(data).toEqual([{ id: 'tab-1', data: 'hi' }])
  })

  it('removes only the unsubscribed wrapper and survives a double unsubscribe', () => {
    const ctx = fakeIpc()
    const api = createApi(ctx.ipc)
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = api.terminal.onExit(first)
    api.terminal.onExit(second)
    ctx.emit('terminal:onExit', { id: 'tab-1', exitCode: 0, signal: null })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    offFirst()
    ctx.emit('terminal:onExit', { id: 'tab-1', exitCode: 0, signal: null })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(() => offFirst()).not.toThrow()
    expect(ctx.ipc.removeListener).toHaveBeenCalledTimes(2)
  })

  it('registers subscribe leaves on their exact channel', () => {
    const ctx = fakeIpc()
    const api = createApi(ctx.ipc)
    const off = api.settings.onChanged(() => undefined)
    const offEvent = api.sessions.onEvent(() => undefined)
    expect([...ctx.listeners.keys()]).toEqual(['settings:onChanged', 'sessions:onEvent'])
    off()
    offEvent()
    expect([...ctx.listeners.keys()].map((channel) => ctx.listeners.get(channel)?.length)).toEqual([0, 0])
  })
})
