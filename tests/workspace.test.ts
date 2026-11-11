import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LoginShareStatus, PublicSettings, WorkspaceRef } from '../src/shared/types'
import type { WorkspaceHost } from '../src/main/host/host'
import { WorkspaceGate } from '../src/main/services/workspace-gate'
import { WorkspaceService, type WorkspaceServiceDeps } from '../src/main/services/workspace'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function host(id = 'local', path = '/work'): WorkspaceHost {
  return {
    id,
    kind: id === 'local' ? 'local' : 'ssh',
    path: posix,
    home: async () => '/home/me',
    stat: async () => ({ isFile: false, isDirectory: true, size: 0, mtimeMs: 0 }),
    realpath: async (value: string) => value
  } as unknown as WorkspaceHost
}

function settingsValue(hostId: string, path: string): PublicSettings {
  return { workspaceHost: hostId, workspacePath: path } as PublicSettings
}

function makeDeps() {
  const calls: string[] = []
  const settings = {
    workspaceHost: 'local',
    workspacePath: '/work',
    publicSettings: () => settingsValue(settings.workspaceHost, settings.workspacePath),
    setWorkspace: vi.fn((ref: WorkspaceRef) => {
      calls.push('setWorkspace')
      settings.workspaceHost = ref.host
      settings.workspacePath = ref.path
      return settings.publicSettings()
    }),
    setShareLogins: vi.fn((_hostId: string, enabled: boolean) => {
      calls.push(`setShareLogins:${enabled}`)
      return settings.publicSettings()
    })
  }
  const registry = { connect: vi.fn(async (id: string) => host(id, id === 'local' ? '/work' : '/srv/app')) }
  const loop = {
    drain: vi.fn(async () => {
      calls.push('loop.drain')
    })
  }
  const consult = {
    dispose: vi.fn(async () => {
      calls.push('consult.dispose')
    })
  }
  const sessions = {
    dispose: vi.fn(async () => {
      calls.push('sessions.dispose')
    })
  }
  const terminal = {
    dispose: vi.fn(() => {
      calls.push('terminal.dispose')
    })
  }
  const plan = {
    resetWatching: vi.fn(() => calls.push('plan.reset')),
    listGoals: vi.fn(async () => {
      calls.push('plan.listGoals')
      return []
    })
  }
  const git = {
    resetWatching: vi.fn(() => calls.push('git.reset')),
    summary: vi.fn(async () => {
      calls.push('git.summary')
      return { isRepo: true, root: '/work', files: [], clean: true } as never
    })
  }
  const status: LoginShareStatus = { hostId: 'devbox', enabled: true, active: true, error: null }
  const loginShare = {
    prelude: vi.fn(async () => ''),
    detach: vi.fn(async () => undefined),
    status: vi.fn(() => status)
  }
  const omp = { refresh: vi.fn((): unknown => calls.push('omp.refresh')) }
  const gate = new WorkspaceGate()
  const onGoals = vi.fn(() => calls.push('onGoals'))
  const onGit = vi.fn(() => calls.push('onGit'))
  const deps = {
    settings,
    registry,
    omp,
    loginShare,
    loop,
    consult,
    broker: { cancelAll: () => calls.push('broker.cancelAll') },
    sessions,
    terminal,
    plan,
    git,
    gate,
    onGoals,
    onGit
  } as unknown as WorkspaceServiceDeps
  return { deps, calls, settings, registry, loop, consult, sessions, terminal, plan, git, loginShare, omp, gate, onGoals, onGit }
}

describe('WorkspaceService.open', () => {
  it('does nothing for the current host and path', async () => {
    const { deps, calls } = makeDeps()
    const service = new WorkspaceService(deps)
    const result = await service.open({ host: 'local', path: '/work' })
    expect(result.workspacePath).toBe('/work')
    expect(calls).toEqual([])
  })

  it('validates before any teardown or mutation', async () => {
    const { deps, calls, settings, registry } = makeDeps()
    registry.connect.mockImplementationOnce(
      async () =>
        ({
          ...host(),
          stat: async () => null
        }) as unknown as WorkspaceHost
    )
    const service = new WorkspaceService(deps)
    await expect(service.open({ host: 'local', path: '/missing' })).rejects.toThrow(/Folder not found/)
    expect(settings.setWorkspace).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('drains agents before mutating the workspace, then resets and pushes', async () => {
    const { deps, calls, settings, loop, plan, git, onGoals, onGit } = makeDeps()
    let release!: () => void
    loop.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          calls.push('loop.drain')
          release = resolve
        })
    )
    const service = new WorkspaceService(deps)
    const opening = service.open({ host: 'local', path: '/next' })
    await tick()
    expect(calls).toContain('loop.drain')
    expect(settings.setWorkspace).not.toHaveBeenCalled()
    release()
    await opening
    const order = calls.join(',')
    expect(order.indexOf('loop.drain')).toBeLessThan(order.indexOf('setWorkspace'))
    expect(settings.setWorkspace).toHaveBeenCalledWith({ host: 'local', path: '/next' })
    expect(plan.resetWatching).toHaveBeenCalledTimes(1)
    expect(git.resetWatching).toHaveBeenCalledTimes(1)
    expect(onGoals).toHaveBeenCalledTimes(1)
    expect(onGit).toHaveBeenCalledTimes(1)
  })

  it('pushes the not-a-repo summary when git fails during an open', async () => {
    const { deps, git, onGit, onGoals, settings } = makeDeps()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      git.summary.mockRejectedValueOnce(new Error('git: command not found'))
      await new WorkspaceService(deps).open({ host: 'local', path: '/next' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    expect(settings.workspacePath).toBe('/next')
    expect(onGoals).toHaveBeenCalledTimes(1)
    expect(onGit).toHaveBeenCalledWith({
      isRepo: false,
      root: null,
      branch: null,
      ahead: 0,
      behind: 0,
      files: [],
      clean: true,
      head: null
    })
  })

  it('serializes concurrent opens and keeps the last target', async () => {
    const { deps, calls, settings, registry, loop } = makeDeps()
    let release!: () => void
    loop.drain.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          calls.push('loop.drain:first')
          release = resolve
        })
    )
    const service = new WorkspaceService(deps)
    const first = service.open({ host: 'local', path: '/one' })
    await tick()
    const second = service.open({ host: 'local', path: '/two' })
    await tick()
    expect(registry.connect).toHaveBeenCalledTimes(1)
    release()
    await first
    await second
    expect(settings.workspacePath).toBe('/two')
  })
})

describe('WorkspaceService.restartAgents', () => {

  it('cancels pending approvals before waiting on the loop', async () => {
    const { deps, calls, loop } = makeDeps()
    let approvalsCancelled = false
    deps.broker.cancelAll = () => {
      calls.push('broker.cancelAll')
      approvalsCancelled = true
    }
    loop.drain.mockImplementation(async () => {
      calls.push('loop.drain')
      if (!approvalsCancelled) await new Promise<void>(() => undefined)
    })
    const result = await Promise.race([
      new WorkspaceService(deps).restartAgents().then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100))
    ])
    expect(result).toBe('done')
  })

  it('reopens admissions before refreshing omp after an open', async () => {
    const { deps, omp, gate } = makeDeps()
    let blockedAtRefresh: boolean | null = null
    omp.refresh.mockImplementation((): unknown => {
      blockedAtRefresh = gate.blocked
      return undefined
    })
    const service = new WorkspaceService(deps)
    await service.open({ host: 'local', path: '/next' })
    expect(blockedAtRefresh).toBe(false)
  })

  it('drains in order and blocks admissions while it runs', async () => {
    const { deps, calls, loop, gate } = makeDeps()
    let release!: () => void
    loop.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          calls.push('loop.drain')
          release = resolve
        })
    )
    const service = new WorkspaceService(deps)
    const restarting = service.restartAgents()
    await tick()
    expect(gate.blocked).toBe(true)
    expect(() => gate.assertOpen()).toThrow(/workspace is changing/)
    release()
    await restarting
    expect(calls).toEqual(['broker.cancelAll', 'loop.drain', 'consult.dispose', 'sessions.dispose', 'terminal.dispose'])
    expect(gate.blocked).toBe(false)
  })

  it('runs every drain step and rethrows the first error', async () => {
    const { deps, calls, loop, consult, sessions, terminal, gate } = makeDeps()
    const first = new Error('loop failed')
    loop.drain.mockImplementationOnce(async () => {
      calls.push('loop.drain')
      throw first
    })
    consult.dispose.mockImplementationOnce(async () => {
      calls.push('consult.dispose')
      throw new Error('consult failed')
    })
    const service = new WorkspaceService(deps)
    await expect(service.restartAgents()).rejects.toBe(first)
    expect(calls).toEqual(['broker.cancelAll', 'loop.drain', 'consult.dispose', 'sessions.dispose', 'terminal.dispose'])
    expect(sessions.dispose).toHaveBeenCalledTimes(1)
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
    expect(gate.blocked).toBe(false)
  })
})

describe('WorkspaceService.setLoginShare', () => {
  it('drains before flipping the setting and surfaces an attach error', async () => {
    const { deps, calls, settings, loginShare, gate } = makeDeps()
    settings.workspaceHost = 'devbox'
    loginShare.status.mockReturnValue({ hostId: 'devbox', enabled: true, active: false, error: 'tunnel down' })
    const service = new WorkspaceService(deps)
    await expect(service.setLoginShare(true)).rejects.toThrow(/tunnel down/)
    expect(settings.setShareLogins).toHaveBeenCalledWith('devbox', true)
    const order = calls.join(',')
    expect(order.indexOf('loop.drain')).toBeLessThan(order.indexOf('setShareLogins:true'))
    expect(gate.blocked).toBe(false)
  })

  it('drains before connecting so an unreachable host rejects after the drain', async () => {
    const { deps, calls, settings, registry, sessions, gate } = makeDeps()
    settings.workspaceHost = 'devbox'
    registry.connect.mockImplementationOnce(async () => {
      calls.push('connect')
      throw new Error('ssh: connect timed out')
    })
    const service = new WorkspaceService(deps)
    await expect(service.setLoginShare(true)).rejects.toThrow(/connect timed out/)
    const order = calls.join(',')
    expect(order.indexOf('sessions.dispose')).toBeLessThan(order.indexOf('connect'))
    expect(sessions.dispose).toHaveBeenCalledTimes(1)
    expect(settings.setShareLogins).not.toHaveBeenCalled()
    expect(gate.blocked).toBe(false)
  })

  it('detaches when disabling and returns the status', async () => {
    const { deps, settings, loginShare } = makeDeps()
    settings.workspaceHost = 'devbox'
    loginShare.status.mockReturnValue({ hostId: 'devbox', enabled: false, active: false, error: null })
    const service = new WorkspaceService(deps)
    const result = await service.setLoginShare(false)
    expect(settings.setShareLogins).toHaveBeenCalledWith('devbox', false)
    expect(loginShare.detach).toHaveBeenCalledTimes(1)
    expect(loginShare.prelude).not.toHaveBeenCalled()
    expect(result.status.enabled).toBe(false)
  })
})
