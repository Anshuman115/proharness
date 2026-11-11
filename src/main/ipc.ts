import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { resolve, sep } from 'node:path'
import type {
  ConsultRequest,
  LoopConfig,
  SessionCreateInput,
  SettingsPatch,
  TerminalCreateInput,
  ThinkingLevel,
  UiResponse,
  WorkspaceListing,
  WorkspaceRef
} from '@shared/types'
import type { HostRegistry } from './host/registry'
import type { LoginShare } from './services/login-share'
import type { ConsultService } from './services/consult'
import type { GitService } from './services/git'
import type { OmpService } from './services/omp'
import type { PlanService } from './services/plan'
import type { SessionManager } from './services/sessions'
import type { SettingsService } from './services/settings'
import type { TaskLoopService } from './services/task-loop'
import type { TerminalService } from './services/terminal'
import type { UiBroker } from './services/ui-broker'
import type { WorkspaceService } from './services/workspace'
import { expandPath } from './services/workspace'
import {
  bindIpc,
  createEventSenders,
  type EventSenders,
  type InvokeHandlers,
  type RootHandlers,
  type SendHandlers
} from './ipc/registry'

interface IpcDependencies {
  getWindow: () => BrowserWindow | null
  appVersion: string
  settings: SettingsService
  registry: HostRegistry
  loginShare: LoginShare
  omp: OmpService
  plan: PlanService
  git: GitService
  sessions: SessionManager
  broker: UiBroker
  terminal: TerminalService
  consult: ConsultService
  loop: TaskLoopService
  workspace: WorkspaceService
}

/**
 * Registers every invoke/send handler from the typed maps and returns the typed
 * push helpers for the subscribe leaves. Validation stays in the handlers.
 */
export function registerIpc(deps: IpcDependencies): EventSenders {
  const { getWindow, settings, registry, omp, plan, git, sessions, broker, terminal, consult, loop, workspace } = deps

  const send = (channel: string, ...args: unknown[]): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }

  const insideWorkspace = (input: string): string => {
    if (settings.workspaceHost !== 'local') throw new Error('Not available for remote workspaces.')
    const root = resolve(settings.workspacePath)
    const target = resolve(root, input)
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Path is outside the workspace.')
    return target
  }

  const pick = async (options: Electron.OpenDialogOptions): Promise<string | null> => {
    const window = getWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  }

  const events = createEventSenders(send)

  const invoke: InvokeHandlers = {
    settings: {
      update: (patch) => {
        const previousOmp = settings.ompPath
        const next = settings.update(patch)
        if (previousOmp !== settings.ompPath) void omp.refresh()
        return next
      },
      chooseWorkspace: async () => {
        const path = await pick({
          title: 'Choose a project folder',
          defaultPath: settings.workspaceHost === 'local' ? settings.workspacePath : undefined,
          properties: ['openDirectory', 'createDirectory']
        })
        if (!path) return null
        return workspace.open({ host: 'local', path })
      },
      chooseOmp: () => pick({ title: 'Choose the omp executable', properties: ['openFile'] })
    },
    workspace: {
      open: (ref) => workspace.open(ref),
      sshHosts: () => registry.sshHosts(),
      listDir: async (hostId, input) => {
        const host = await registry.connect(typeof hostId === 'string' ? hostId : 'local')
        let path: string
        let entries: Awaited<ReturnType<typeof host.readdir>>
        try {
          path = await host.realpath(await expandPath(host, typeof input === 'string' ? input : ''))
          entries = await host.readdir(path)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Folder not found on ${host.id}: ${input}`)
          throw error
        }
        entries = entries
          .filter((entry) => entry.isDirectory && !entry.name.startsWith('.'))
          .sort((a, b) => a.name.localeCompare(b.name))
        const repos = new Set<string>()
        const found = await host.exec('find', [path, '-mindepth', '2', '-maxdepth', '2', '-name', '.git'])
        for (const line of found.stdout.split('\n')) {
          const repo = line.trim()
          if (repo) repos.add(host.path.basename(host.path.dirname(repo)))
        }
        return {
          path,
          entries: entries.map((entry) => ({ name: entry.name, isDirectory: true, isRepo: repos.has(entry.name) }))
        }
      }
    },
    loginShare: {
      status: () => deps.loginShare.status(settings.workspaceHost),
      set: (enabled) => workspace.setLoginShare(Boolean(enabled))
    },
    omp: {
      refresh: () => omp.refresh()
    },
    goals: {
      list: () => plan.listGoals(),
      create: async (title) => {
        const summary = await plan.createGoal(title)
        await git.excludeGoals()
        events.goals.onChanged(await plan.listGoals())
        return summary
      },
      read: (goalId) => plan.readGoal(goalId),
      toggleTask: async (goalId, taskId, checked) => {
        const detail = await plan.setTaskChecked(goalId, taskId, checked)
        events.goals.onChanged(await plan.listGoals())
        return detail
      }
    },
    git: {
      summary: () => git.summary(),
      fileDiff: (path) => git.fileDiff(path),
      restore: async (path) => {
        const summary = await git.restoreFile(path)
        events.git.onChanged(summary)
        return summary
      }
    },
    sessions: {
      create: (input) => sessions.create(input),
      send: (tabId, text, behavior) => sessions.send(tabId, text, behavior),
      stop: (tabId) => sessions.stop(tabId),
      close: (tabId) => sessions.close(tabId),
      setModel: (tabId, model) => sessions.setModel(tabId, model),
      setThinking: (tabId, level) => sessions.setThinking(tabId, level),
      newConversation: (tabId) => sessions.newConversation(tabId),
      resume: (tabId, file) => sessions.resume(tabId, file),
      compact: (tabId) => sessions.compact(tabId),
      removeQueued: (tabId, message, queue) => sessions.removeQueued(tabId, message, queue),
      recent: () => sessions.recent()
    },
    ui: {
      respond: (response) => broker.respond(response)
    },
    terminal: {
      create: (input) => terminal.create(input),
      kill: (id) => terminal.kill(id)
    },
    consult: {
      start: (request) => consult.start(request),
      cancel: (requestId) => consult.cancel(requestId)
    },
    loop: {
      start: (config) => loop.start(config),
      pause: () => loop.pause(),
      resume: () => loop.resume(),
      stop: () => loop.stop(),
      state: () => loop.getState()
    },
    shell: {
      openPath: (path) => shell.openPath(insideWorkspace(path)),
      showItem: (path) => shell.showItemInFolder(insideWorkspace(path)),
      openExternal: async (url) => {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) links can be opened.')
        await shell.openExternal(parsed.toString())
      }
    }
  }

  const sendHandlers: SendHandlers = {
    settings: {},
    workspace: {},
    loginShare: {},
    omp: {},
    goals: {},
    git: {},
    sessions: {},
    ui: {},
    terminal: {
      write: (id, data) => terminal.write(id, data),
      resize: (id, cols, rows) => terminal.resize(id, cols, rows)
    },
    consult: {},
    loop: {},
    shell: {}
  }

  const root: RootHandlers = {
    bootstrap: async () => ({
      settings: settings.publicSettings(),
      goals: await plan.listGoals(),
      git: await git.summary(),
      omp: omp.current(),
      appVersion: deps.appVersion
    })
  }

  bindIpc(ipcMain, invoke, sendHandlers, root)
  return events
}
