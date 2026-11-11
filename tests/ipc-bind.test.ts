import { describe, expect, it, vi } from 'vitest'
import type { Bootstrap, GitSummary, OmpStatus, PublicSettings, SessionEvent, SettingsPatch, TerminalDataEvent } from '../src/shared/types'
import { IPC_METHODS } from '../src/shared/ipc'
import {
  bindIpc,
  createEventSenders,
  type InvokeHandlers,
  type RootHandlers,
  type SendHandlers
} from '../src/main/ipc/registry'

type Target = Parameters<typeof bindIpc>[0]

function fakeIpc(): {
  ipc: Target
  handles: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  ons: Map<string, (event: unknown, ...args: unknown[]) => void>
} {
  const handles = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ons = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const ipc = {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handles.set(channel, listener)
    }),
    on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      ons.set(channel, listener)
    })
  }
  return { ipc: ipc as unknown as Target, handles, ons }
}

function handlers(
  invoke: Record<string, Record<string, (...args: never[]) => unknown>>,
  send: Record<string, Record<string, (...args: never[]) => void>> = {}
): { invoke: InvokeHandlers; send: SendHandlers } {
  return { invoke: invoke as unknown as InvokeHandlers, send: send as unknown as SendHandlers }
}

const BOOTSTRAP: Bootstrap = {
  settings: {} as PublicSettings,
  goals: [],
  git: {} as GitSummary,
  omp: {} as OmpStatus,
  appVersion: 'test'
}
const ROOT: RootHandlers = { bootstrap: async () => BOOTSTRAP }

describe('bindIpc', () => {
  it('registers every invoke and send descriptor channel plus bootstrap', () => {
    const ctx = fakeIpc()
    const expected = new Set<string>(['app:bootstrap'])
    const sends: string[] = []
    let invokes = 0
    let subscribes = 0
    for (const [namespace, methods] of Object.entries(IPC_METHODS)) {
      for (const [method, kind] of Object.entries(methods)) {
        if (kind === 'subscribe') {
          subscribes += 1
          continue
        }
        if (kind === 'invoke') {
          expected.add(`${namespace}:${method}`)
          invokes += 1
        } else {
          sends.push(`${namespace}:${method}`)
        }
      }
    }
    bindIpc(ctx.ipc, handlers({}).invoke, handlers({}).send, ROOT)
    expect(invokes).toBe(40)
    expect(sends).toEqual(['terminal:write', 'terminal:resize'])
    expect(subscribes).toBe(11)
    expect(new Set(ctx.handles.keys())).toEqual(expected)
    expect(new Set(ctx.ons.keys())).toEqual(new Set(sends))
  })

  it('drops the Electron event, forwards args and returns the handler result', async () => {
    const ctx = fakeIpc()
    const update = vi.fn(async (_patch: SettingsPatch) => ({}) as PublicSettings)
    const { invoke, send } = handlers({ settings: { update } })
    bindIpc(ctx.ipc, invoke, send, ROOT)
    const listener = ctx.handles.get('settings:update')
    expect(listener).toBeTypeOf('function')
    const result = await (listener!({ fakeEvent: true }, { chatApproval: 'yolo' }) as Promise<unknown>)
    expect(update).toHaveBeenCalledWith({ chatApproval: 'yolo' })
    expect(result).toEqual({})
  })

  it('drops the Electron event for send leaves and returns void', () => {
    const ctx = fakeIpc()
    const write = vi.fn()
    const resize = vi.fn()
    const { invoke, send } = handlers({}, { terminal: { write, resize } })
    bindIpc(ctx.ipc, invoke, send, ROOT)
    const result = ctx.ons.get('terminal:write')!({ fakeEvent: true }, 'tab-1', 'ls\n')
    expect(result).toBeUndefined()
    expect(write).toHaveBeenCalledWith('tab-1', 'ls\n')
    ctx.ons.get('terminal:resize')!({ fakeEvent: true }, 'tab-1', 100, 30)
    expect(resize).toHaveBeenCalledWith('tab-1', 100, 30)
  })

  it('propagates a rejecting handler', async () => {
    const ctx = fakeIpc()
    const failing = vi.fn(async () => {
      throw new Error('boom')
    })
    const { invoke, send } = handlers({ git: { summary: failing } })
    bindIpc(ctx.ipc, invoke, send, ROOT)
    const listener = ctx.handles.get('git:summary')!
    await expect(Promise.resolve(listener({}))).rejects.toThrow('boom')
  })

  it('registers bootstrap separately on its own channel', async () => {
    const ctx = fakeIpc()
    const bootstrap = vi.fn(async () => BOOTSTRAP)
    bindIpc(ctx.ipc, handlers({}).invoke, handlers({}).send, { bootstrap })
    expect(ctx.handles.has('app:bootstrap')).toBe(true)
    await expect((ctx.handles.get('app:bootstrap')!({})) as Promise<unknown>).resolves.toEqual(BOOTSTRAP)
  })
})

describe('createEventSenders', () => {
  it('sends the derived channel with the exact payload tuple', () => {
    const sent: Array<{ channel: string; args: unknown[] }> = []
    const events = createEventSenders((channel, ...args) => sent.push({ channel, args }))
    const settings = { workspacePath: '/tmp/x' } as PublicSettings
    const session = { type: 'status', status: 'idle' } as SessionEvent
    const terminal = { id: 'tab-1', data: 'hi' } as TerminalDataEvent
    events.settings.onChanged(settings)
    events.sessions.onEvent('tab-1', session)
    events.terminal.onData(terminal)
    expect(sent).toEqual([
      { channel: 'settings:onChanged', args: [settings] },
      { channel: 'sessions:onEvent', args: ['tab-1', session] },
      { channel: 'terminal:onData', args: [terminal] }
    ])
  })
})
