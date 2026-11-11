import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LocalHost } from '../src/main/host/local'
import type { OmpAgent } from '../src/main/omp/agent'
import { AgentFactory } from '../src/main/services/agents'
import type { GitService } from '../src/main/services/git'
import type { OmpService } from '../src/main/services/omp'
import type { PlanService } from '../src/main/services/plan'
import type { SettingsService } from '../src/main/services/settings'
import { UiBroker } from '../src/main/services/ui-broker'

interface Captures {
  args: string[][]
  tools: unknown[]
}

type FakeChild = ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> }

function fakeChild(captures: Captures): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new EventEmitter() as never
  child.stderr = new EventEmitter() as never
  const stdin = new EventEmitter() as EventEmitter & { write: (chunk: string) => void; end: () => void }
  stdin.write = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      const frame = JSON.parse(line) as { type: string; id: string; tools?: unknown }
      if (frame.type === 'set_host_tools') captures.tools.push(frame.tools)
      if (frame.type === 'set_event_filter' || frame.type === 'set_host_tools' || frame.type === 'get_state') {
        ;(child.stdout as unknown as EventEmitter).emit(
          'data',
          Buffer.from(JSON.stringify({ type: 'response', id: frame.id, success: true, data: {} }) + '\n')
        )
      }
    }
  }
  stdin.end = () => {
    setImmediate(() => child.emit('exit', 0, null))
  }
  child.stdin = stdin as never
  child.kill = vi.fn() as never
  setImmediate(() => (child.stdout as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify({ type: 'ready' }) + '\n')))
  return child
}

function build(): { agents: AgentFactory; captures: Captures; overlayFor: ReturnType<typeof vi.fn> } {
  const captures: Captures = { args: [], tools: [] }
  const overlayFor = vi.fn(async () => '/tmp/omp-overlay.yml')
  const omp = {
    spawner: async () => async (args: string[]) => {
      captures.args.push(args)
      return fakeChild(captures)
    },
    overlayFor,
    current: () => ({ defaultModel: null })
  } as unknown as OmpService
  const settings = { chatApproval: 'write', chatModel: 'provider/chat' } as SettingsService
  const agents = new AgentFactory(
    settings,
    omp,
    {} as PlanService,
    {} as GitService,
    new UiBroker(),
    () => new LocalHost()
  )
  return { agents, captures, overlayFor }
}

function toolNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map((tool) => String((tool as { name?: unknown }).name ?? '')) : []
}

describe('AgentFactory role configuration', () => {
  it('gives the implementer the plan overlay and host tools', async () => {
    const { agents, captures, overlayFor } = build()
    const agent: OmpAgent = await agents.implementer({
      model: 'provider/impl',
      approval: 'yolo',
      label: 'Implementer',
      onEvent: () => undefined
    })
    try {
      await agent.start()
      const args = captures.args[0]
      expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--approval-mode', 'yolo', '--model', 'provider/impl', '--config', '/tmp/omp-overlay.yml']))
      expect(args).not.toContain('--tools')
      expect(toolNames(captures.tools[0])).toEqual(expect.arrayContaining(['plan_list', 'git_status']))
      expect(overlayFor).toHaveBeenCalledTimes(1)
    } finally {
      await agent.close()
    }
  })

  it('keeps the reviewer read-only with no overlay and no host tools', async () => {
    const { agents, captures, overlayFor } = build()
    const agent = await agents.reviewer({ model: 'provider/review', label: 'Reviewer', onEvent: () => undefined })
    try {
      await agent.start()
      const args = captures.args[0]
      expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--approval-mode', 'yolo', '--tools', 'read,grep,glob', '--no-extensions']))
      expect(args).not.toContain('--config')
      expect(captures.tools).toHaveLength(0)
      expect(overlayFor).not.toHaveBeenCalled()
    } finally {
      await agent.close()
    }
  })

  it('builds chat with rpc-ui, the chat model and the plan overlay', async () => {
    const { agents, captures, overlayFor } = build()
    const agent = await agents.chat({
      tabId: 'tab-1',
      model: 'provider/chat',
      originLabel: () => 'Tab 1',
      onEvent: () => undefined
    })
    try {
      await agent.start()
      const args = captures.args[0]
      expect(args).toEqual(
        expect.arrayContaining(['--mode', 'rpc-ui', '--approval-mode', 'write', '--model', 'provider/chat', '--config', '/tmp/omp-overlay.yml'])
      )
      expect(toolNames(captures.tools[0])).toEqual(expect.arrayContaining(['plan_list', 'git_status']))
      expect(overlayFor).toHaveBeenCalledTimes(1)
    } finally {
      await agent.close()
    }
  })
})
