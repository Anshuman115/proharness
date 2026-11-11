/// <reference path="../src/renderer/src/types.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLoopState } from '../src/shared/defaults'
import type {
  Bootstrap,
  GitFileDiff,
  GitSummary,
  GoalDetail,
  LoginShareStatus,
  OmpStatus,
  PublicSettings,
  RecentSession,
  UiRequest
} from '../src/shared/types'

type StoreModule = typeof import('../src/renderer/src/store')

let useAppStore: StoreModule['useAppStore']
let api: ReturnType<typeof createApi>

function settings(overrides: Partial<PublicSettings> = {}): PublicSettings {
  return {
    workspacePath: '/repo/a',
    workspaceHost: 'local',
    workspaceName: 'a',
    recentWorkspaces: [],
    ompPath: '',
    chatModel: '',
    chatApproval: 'write',
    implementerModel: '',
    reviewerModel: '',
    modelNotes: [],
    loopApproval: 'yolo',
    pinnedModels: [],
    terminalShell: '/bin/zsh',
    reduceMotion: false,
    ...overrides
  }
}

const gitSummary: GitSummary = {
  isRepo: true,
  root: '/repo/a',
  branch: 'main',
  ahead: 0,
  behind: 0,
  files: [],
  clean: true,
  head: 'abc123'
}

const ompStatus: OmpStatus = {
  hostId: 'local',
  ok: true,
  path: '/usr/local/bin/omp',
  version: '18.18.8',
  error: null,
  defaultModel: null,
  models: [],
  checkedAt: 1
}

const goalDetail = (id: string): GoalDetail => ({
  id,
  title: id,
  summary: '',
  status: 'active',
  designPath: '',
  planPath: '',
  phaseCount: 0,
  taskCount: 0,
  openCount: 0,
  progress: 0,
  updatedAt: 0,
  design: '',
  plan: '',
  phases: []
})

const request = (id: string): UiRequest => ({
  id,
  origin: 'session',
  originId: 'old-tab',
  originLabel: '',
  method: 'confirm',
  title: '',
  message: '',
  options: [],
  optionDetails: [],
  placeholder: '',
  approval: null,
  createdAt: 1
})

const recentSession: RecentSession = { file: '/sessions/old.jsonl', title: 'Old', updatedAt: 1, model: null }

function boot(overrides: Partial<PublicSettings> = {}): Bootstrap {
  return { settings: settings(overrides), goals: [], git: gitSummary, omp: ompStatus, appVersion: '0.0.0-test' }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createApi(): {
  bootstrap: ReturnType<typeof vi.fn>
  settings: Record<string, ReturnType<typeof vi.fn>>
  workspace: Record<string, ReturnType<typeof vi.fn>>
  loginShare: Record<string, ReturnType<typeof vi.fn>>
  omp: Record<string, ReturnType<typeof vi.fn>>
  goals: Record<string, ReturnType<typeof vi.fn>>
  git: Record<string, ReturnType<typeof vi.fn>>
  sessions: Record<string, ReturnType<typeof vi.fn>>
  ui: Record<string, ReturnType<typeof vi.fn>>
  terminal: Record<string, ReturnType<typeof vi.fn>>
  consult: Record<string, ReturnType<typeof vi.fn>>
  loop: Record<string, ReturnType<typeof vi.fn>>
  shell: Record<string, ReturnType<typeof vi.fn>>
} {
  const off = (): void => undefined
  return {
    bootstrap: vi.fn(async () => boot()),
    settings: {
      update: vi.fn(async (patch: Partial<PublicSettings>) => settings(patch)),
      chooseWorkspace: vi.fn(async (): Promise<PublicSettings | null> => null),
      chooseOmp: vi.fn(async (): Promise<string | null> => null),
      onChanged: vi.fn(() => off)
    },
    workspace: {
      open: vi.fn(async () => settings()),
      sshHosts: vi.fn(async () => []),
      listDir: vi.fn(async () => ({ path: '/', entries: [] }))
    },
    loginShare: {
      status: vi.fn(async (): Promise<LoginShareStatus> => ({ hostId: 'local', enabled: false, active: false, error: null })),
      set: vi.fn(async (enabled: boolean) => ({
        settings: settings(),
        status: { hostId: 'local', enabled, active: enabled, error: null } as LoginShareStatus
      }))
    },
    omp: { refresh: vi.fn(async () => ompStatus), onChanged: vi.fn(() => off) },
    goals: {
      list: vi.fn(async () => []),
      create: vi.fn(async (title: string) => ({ ...goalDetail(title), title })),
      read: vi.fn(async (id: string) => goalDetail(id)),
      toggleTask: vi.fn(async (id: string) => goalDetail(id)),
      onChanged: vi.fn(() => off)
    },
    git: {
      summary: vi.fn(async () => gitSummary),
      fileDiff: vi.fn(
        async (path: string): Promise<GitFileDiff> => ({ path, diff: '', binary: false, untracked: false, truncated: false })
      ),
      restore: vi.fn(async () => gitSummary),
      onChanged: vi.fn(() => off)
    },
    sessions: {
      create: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinking: vi.fn(async () => undefined),
      newConversation: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      compact: vi.fn(async () => undefined),
      removeQueued: vi.fn(async () => undefined),
      recent: vi.fn(async () => []),
      onEvent: vi.fn(() => off)
    },
    ui: { respond: vi.fn(async () => undefined), onRequest: vi.fn(() => off), onResolved: vi.fn(() => off) },
    terminal: {
      create: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => undefined),
      onData: vi.fn(() => off),
      onExit: vi.fn(() => off)
    },
    consult: { start: vi.fn(async () => ({ requestId: 'consult-1' })), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => off) },
    loop: {
      start: vi.fn(async () => emptyLoopState()),
      pause: vi.fn(async () => emptyLoopState()),
      resume: vi.fn(async () => emptyLoopState()),
      stop: vi.fn(async () => emptyLoopState()),
      state: vi.fn(async () => emptyLoopState()),
      onEvent: vi.fn(() => off)
    },
    shell: { openPath: vi.fn(async () => ''), showItem: vi.fn(async () => undefined), openExternal: vi.fn(async () => undefined) }
  }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  api = createApi()
  vi.stubGlobal('window', {
    proharness: api,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  })
  ;({ useAppStore } = await import('../src/renderer/src/store'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const store = (): StoreModule['useAppStore'] => useAppStore

describe('settings lifecycle', () => {
  it('creates exactly one tab during bootstrap', async () => {
    await store().getState().init()
    expect(store().getState().tabs).toHaveLength(1)
    expect(api.sessions.create).toHaveBeenCalledTimes(1)
  })

  it('keeps tabs and drafts for a same-workspace catalog update', async () => {
    await store().getState().init()
    const tabId = store().getState().activeTabId
    expect(tabId).toBeTruthy()
    store().getState().setDraft('hello')
    await store().getState().applySettings(settings({ chatModel: 'anthropic/claude-sonnet-5-5' }))
    const state = store().getState()
    expect(state.settings?.chatModel).toBe('anthropic/claude-sonnet-5-5')
    expect(state.tabs.map((tab) => tab.id)).toEqual([tabId])
    expect(state.drafts[tabId as string]).toBe('hello')
    expect(api.sessions.create).toHaveBeenCalledTimes(1)
  })

  it('clears workspace data, refreshes and creates one tab on identity change', async () => {
    await store().getState().init()
    store().getState().setDraft('draft')
    api.git.fileDiff.mockResolvedValueOnce({ path: 'a.txt', diff: 'x', binary: false, untracked: false, truncated: false })
    await store().getState().loadDiff('a.txt')
    api.sessions.recent.mockResolvedValueOnce([recentSession])
    await store().getState().openRecent(true)
    store().getState().addRequest(request('req-1'))
    await store().getState().startConsult('anthropic/claude-sonnet-5-5', 'why', false)
    store().getState().handleLoopEvent({ type: 'state', state: { ...emptyLoopState(), status: 'complete' } })
    const revision = store().getState().workspaceRevision
    const nextGit = { ...gitSummary, root: '/srv/b', branch: 'other' }
    api.git.summary.mockResolvedValueOnce(nextGit)

    await store().getState().applySettings(settings({ workspaceHost: 'devbox', workspacePath: '/srv/b', workspaceName: 'b @ devbox' }))
    const state = store().getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.drafts).toEqual({})
    expect(state.diff).toBeNull()
    expect(state.diffPath).toBeNull()
    expect(state.recent).toEqual([])
    expect(state.recentOpen).toBe(false)
    expect(state.requests).toEqual([])
    expect(state.consults).toEqual([])
    expect(state.loop.status).toBe('idle')
    expect(state.git).toEqual(nextGit)
    expect(state.workspaceRevision).toBe(revision + 1)
    expect(api.sessions.create).toHaveBeenCalledTimes(2)
  })

  it('resets at most once when an event and a response carry the same settings', async () => {
    await store().getState().init()
    const next = settings({ workspaceHost: 'devbox', workspacePath: '/srv/b' })
    api.settings.update.mockResolvedValueOnce(next)
    const updating = store().getState().updateSettings({})
    await store().getState().applySettings(next)
    await updating
    await store().getState().applySettings(next)
    expect(api.sessions.create).toHaveBeenCalledTimes(2)
    expect(store().getState().tabs).toHaveLength(1)
  })

  it('applies a login-share toggle with a forced reset even when identity is unchanged', async () => {
    const remote = settings({ workspaceHost: 'devbox', workspacePath: '/srv/a', workspaceName: 'a @ devbox' })
    api.bootstrap.mockResolvedValue(boot(remote))
    const enabled: LoginShareStatus = { hostId: 'devbox', enabled: true, active: true, error: null }
    api.loginShare.status.mockResolvedValue(enabled)
    api.loginShare.set.mockResolvedValueOnce({ settings: remote, status: enabled })
    await store().getState().init()
    expect(api.sessions.create).toHaveBeenCalledTimes(1)

    await store().getState().setLoginShare(true)
    const state = store().getState()
    expect(state.loginShare).toEqual(enabled)
    expect(state.tabs).toHaveLength(1)
    expect(state.workspaceRevision).toBe(1)
    expect(api.sessions.create).toHaveBeenCalledTimes(2)
  })
})

describe('workspace generation guards', () => {
  it('discards a stale diff after a workspace change', async () => {
    await store().getState().init()
    const pending = deferred<GitFileDiff>()
    api.git.fileDiff.mockReturnValueOnce(pending.promise)
    const loading = store().getState().loadDiff('old.txt')
    await store().getState().applySettings(settings({ workspaceHost: 'devbox', workspacePath: '/srv/b' }))
    pending.resolve({ path: 'old.txt', diff: 'old', binary: false, untracked: false, truncated: false })
    await loading
    expect(store().getState().diff).toBeNull()
    expect(store().getState().diffPath).toBeNull()
  })

  it('discards stale recent sessions and goals after a workspace change', async () => {
    await store().getState().init()
    const recent = deferred<RecentSession[]>()
    api.sessions.recent.mockReturnValueOnce(recent.promise)
    const opening = store().getState().openRecent(true)
    await store().getState().applySettings(settings({ workspaceHost: 'devbox', workspacePath: '/srv/b' }))
    recent.resolve([recentSession])
    await opening
    expect(store().getState().recent).toEqual([])
    expect(store().getState().recentOpen).toBe(false)

    const goal = deferred<GoalDetail>()
    api.goals.read.mockReturnValueOnce(goal.promise)
    const selecting = store().getState().selectGoal('old-goal')
    await store().getState().applySettings(settings({ workspaceHost: 'devbox', workspacePath: '/srv/c' }))
    goal.resolve(goalDetail('old-goal'))
    await selecting
    expect(store().getState().goalDetail).toBeNull()
    expect(store().getState().activeGoalId).toBeNull()
  })

  it('closes a session created for a workspace that changed mid-flight', async () => {
    await store().getState().init()
    const creating = deferred<void>()
    api.sessions.create.mockReturnValueOnce(creating.promise)
    const pending = store().getState().createTab({ activate: true })
    await Promise.resolve()
    const staleId = store().getState().tabs[store().getState().tabs.length - 1].id
    await store().getState().applySettings(settings({ workspaceHost: 'devbox', workspacePath: '/srv/b' }))
    creating.resolve()
    await expect(pending).resolves.toBeNull()
    expect(api.sessions.close).toHaveBeenCalledWith(staleId)
    expect(store().getState().tabs).toHaveLength(1)
  })
})

describe('composer focus', () => {
  it('increments on every request', () => {
    const before = store().getState().composerFocus
    store().getState().focusComposer()
    store().getState().focusComposer()
    expect(store().getState().composerFocus).toBe(before + 2)
  })
})

describe('error policy', () => {
  it('rejects settings actions without toasting', async () => {
    await store().getState().init()
    const error = new Error('settings failed')
    api.settings.update.mockRejectedValueOnce(error)
    await expect(store().getState().updateSettings({ ompPath: 'x' })).rejects.toThrow('settings failed')
    expect(store().getState().toast).toBeNull()

    api.settings.chooseWorkspace.mockRejectedValueOnce(error)
    await expect(store().getState().chooseWorkspace()).rejects.toThrow('settings failed')
    expect(store().getState().toast).toBeNull()

    api.workspace.open.mockRejectedValueOnce(error)
    await expect(store().getState().openWorkspace({ host: 'local', path: '/nope' })).rejects.toThrow('settings failed')
    expect(store().getState().toast).toBeNull()
  })

  it('surfaces recent, close and consult-cancel failures once', async () => {
    await store().getState().init()
    api.sessions.recent.mockRejectedValueOnce(new Error('recent failed'))
    await store().getState().openRecent(true)
    expect(store().getState().toast?.message).toBe('recent failed')

    api.sessions.close.mockRejectedValueOnce(new Error('close failed'))
    const tabId = store().getState().activeTabId as string
    await store().getState().closeTab(tabId)
    expect(store().getState().toast?.message).toBe('close failed')

    api.consult.cancel.mockRejectedValueOnce(new Error('cancel failed'))
    await store().getState().cancelConsult('consult-1')
    expect(store().getState().toast?.message).toBe('cancel failed')
  })

  it('resets tabs and toasts once when the toggle fails', async () => {
    const remote = settings({ workspaceHost: 'devbox', workspacePath: '/srv/a', workspaceName: 'a @ devbox' })
    api.bootstrap.mockResolvedValue(boot(remote))
    await store().getState().init()
    expect(api.sessions.create).toHaveBeenCalledTimes(1)
    api.loginShare.set.mockRejectedValueOnce(new Error('login failed'))
    await store().getState().setLoginShare(true)
    expect(store().getState().loginShareBusy).toBe(false)
    expect(store().getState().workspaceRevision).toBe(1)
    expect(store().getState().tabs).toHaveLength(1)
    expect(api.sessions.create).toHaveBeenCalledTimes(2)
    expect(store().getState().toast?.message).toBe('login failed')
  })

  it('resets after a toggle that overlaps a settings save', async () => {
    const remote = settings({ workspaceHost: 'devbox', workspacePath: '/srv/a', workspaceName: 'a @ devbox' })
    api.bootstrap.mockResolvedValue(boot(remote))
    const enabled: LoginShareStatus = { hostId: 'devbox', enabled: true, active: true, error: null }
    api.loginShare.status.mockResolvedValue(enabled)
    await store().getState().init()
    expect(api.sessions.create).toHaveBeenCalledTimes(1)
    const pending = deferred<{ settings: PublicSettings; status: LoginShareStatus }>()
    api.loginShare.set.mockReturnValueOnce(pending.promise)
    const toggling = store().getState().setLoginShare(true)
    api.settings.update.mockResolvedValueOnce(remote)
    await store().getState().updateSettings({})
    pending.resolve({ settings: remote, status: enabled })
    await toggling
    const state = store().getState()
    expect(state.loginShare).toEqual(enabled)
    expect(state.workspaceRevision).toBe(1)
    expect(state.tabs).toHaveLength(1)
    expect(api.sessions.create).toHaveBeenCalledTimes(2)
  })
})
