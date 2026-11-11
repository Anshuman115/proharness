import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLaunch, WorkspaceHost } from '../src/main/host/host'
import { TerminalService } from '../src/main/services/terminal'
import { WorkspaceGate } from '../src/main/services/workspace-gate'

function launch(cwd: string, shell: string): TerminalLaunch {
  return { command: shell, ptyArgs: ['-l'], pipeArgs: ['-i'], cwd, env: {}, shell }
}

function fakePty(): Record<string, unknown> {
  return { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
}

function deferredHost(): {
  host: WorkspaceHost
  resolveNext: (value: TerminalLaunch) => void
} {
  const resolvers: Array<(value: TerminalLaunch) => void> = []
  const terminal = vi.fn(() => new Promise<TerminalLaunch>((resolve) => resolvers.push(resolve)))
  return {
    host: { path: posix, terminal } as unknown as WorkspaceHost,
    resolveNext: (value) => resolvers.shift()!(value)
  }
}

function makeService(
  host: WorkspaceHost,
  gate?: WorkspaceGate
): { service: TerminalService; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(() => fakePty())
  const service = new TerminalService(
    () => '/work',
    () => '/bin/zsh',
    () => host,
    gate
  )
  ;(service as unknown as { ptyModule: unknown }).ptyModule = { spawn }
  return { service, spawn }
}

const input = { id: 't1', cwd: '', cols: 80, rows: 24 }

describe('TerminalService create races', () => {

  it('rejects a create while a workspace transition is busy', async () => {
    const { host } = deferredHost()
    const gate = new WorkspaceGate()
    const { service, spawn } = makeService(host, gate)
    gate.begin()
    try {
      await expect(service.create(input)).rejects.toThrow(/workspace is changing/)
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      gate.end()
    }
  })

  it('rejects a pending create when a transition begins before the launch resolves', async () => {
    const { host, resolveNext } = deferredHost()
    const gate = new WorkspaceGate()
    const { service, spawn } = makeService(host, gate)
    const creating = service.create(input)
    const expectation = expect(creating).rejects.toThrow(/workspace is changing/)
    gate.begin()
    try {
      resolveNext(launch('/work', '/bin/zsh'))
      await expectation
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      gate.end()
    }
  })

  it('cancels a pending create when the terminal is killed', async () => {
    const { host, resolveNext } = deferredHost()
    const { service, spawn } = makeService(host)
    const creating = service.create(input)
    const expectation = expect(creating).rejects.toThrow(/cancelled/)
    service.kill('t1')
    resolveNext(launch('/work', '/bin/zsh'))
    await expectation
    expect(spawn).not.toHaveBeenCalled()
  })

  it('cancels a pending create when the service is disposed', async () => {
    const { host, resolveNext } = deferredHost()
    const { service, spawn } = makeService(host)
    const creating = service.create(input)
    const expectation = expect(creating).rejects.toThrow(/cancelled/)
    service.dispose()
    resolveNext(launch('/work', '/bin/zsh'))
    await expectation
    expect(spawn).not.toHaveBeenCalled()
  })

  it('lets the latest concurrent create for an id win', async () => {
    const { host, resolveNext } = deferredHost()
    const { service, spawn } = makeService(host)
    const first = service.create(input)
    const firstExpectation = expect(first).rejects.toThrow(/cancelled/)
    const second = service.create(input)
    resolveNext(launch('/work', '/bin/zsh'))
    await firstExpectation
    resolveNext(launch('/work', '/bin/zsh'))
    await expect(second).resolves.toMatchObject({ id: 't1', mode: 'pty', cwd: '/work' })
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
