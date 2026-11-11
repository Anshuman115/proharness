import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { CH } from '@shared/channels'
import type {
  DelegateRequest,
  LoopConfig,
  PermissionDecision,
  SettingsPatch,
  TerminalCreateInput
} from '@shared/types'
import type { GitService } from './services/git'
import type { PermissionBroker } from './services/permissions'
import type { PlanService } from './services/plan'
import type { ProviderService } from './services/providers'
import type { SessionManager } from './services/sessions'
import type { SettingsService } from './services/settings'
import type { TaskLoopService } from './services/task-loop'
import type { TerminalService } from './services/terminal'

export interface IpcDependencies {
  getWindow: () => BrowserWindow | null
  settings: SettingsService
  plan: PlanService
  git: GitService
  providers: ProviderService
  sessions: SessionManager
  permissions: PermissionBroker
  terminal: TerminalService
  loop: TaskLoopService
}

export function registerIpc(deps: IpcDependencies): void {
  const { getWindow, settings, plan, git, providers, sessions, permissions, terminal, loop } = deps

  const send = (channel: string, ...args: unknown[]): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }

  const insideWorkspace = (input: string): string => {
    const root = resolve(settings.workspacePath)
    const target = resolve(root, input)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error('Path is outside the workspace.')
    }
    return target
  }

  const refreshAfterWorkspaceChange = async (previous: string): Promise<void> => {
    if (previous === settings.workspacePath) return
    await loop.stop()
    permissions.denyAll('The workspace changed.')
    sessions.dispose()
    terminal.dispose()
    plan.resetWatching()
    git.resetWatching()
    send(CH.goalsChanged, plan.listGoals())
    send(CH.gitChanged, await git.summary())
  }

  ipcMain.handle(CH.bootstrap, async () => {
    return {
      settings: settings.publicSettings(),
      goals: plan.listGoals(),
      git: await git.summary(),
      appVersion: app.getVersion(),
      platform: process.platform
    }
  })

  ipcMain.handle(CH.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    claudeCodeVersion: null,
    nodePtyAvailable: terminal.available
  }))

  ipcMain.handle(CH.settingsUpdate, async (_event, patch: SettingsPatch) => {
    const previous = settings.workspacePath
    const next = settings.update(patch)
    await refreshAfterWorkspaceChange(previous)
    return next
  })

  ipcMain.handle(CH.settingsChooseWorkspace, async () => {
    const window = getWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a project workspace',
      defaultPath: settings.workspacePath,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const previous = settings.workspacePath
    const next = settings.update({ workspacePath: result.filePaths[0] })
    await refreshAfterWorkspaceChange(previous)
    return next
  })

  ipcMain.handle(CH.settingsChooseExecutable, async () => {
    const window = getWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose Claude Code executable',
      properties: ['openFile']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(CH.goalsList, () => plan.listGoals())
  ipcMain.handle(CH.goalsInit, () => {
    plan.ensureRoot()
    plan.resetWatching()
    const goals = plan.listGoals()
    send(CH.goalsChanged, goals)
    return plan.goalsRoot
  })
  ipcMain.handle(CH.goalsRead, (_event, goalId: string) => plan.readGoal(goalId))
  ipcMain.handle(CH.goalsToggleTask, (_event, goalId: string, taskId: string, checked: boolean) => {
    const detail = plan.setTaskChecked(goalId, taskId, checked)
    send(CH.goalsChanged, plan.listGoals())
    return detail
  })

  ipcMain.handle(CH.gitSummary, () => git.summary())
  ipcMain.handle(CH.gitDiff, (_event, path: string) => git.fileDiff(path))
  ipcMain.handle(CH.gitRestore, async (_event, path: string) => {
    const summary = await git.restoreFile(path)
    send(CH.gitChanged, summary)
    return summary
  })
  ipcMain.handle(CH.gitReveal, (_event, path: string) => {
    const absolute = insideWorkspace(path)
    if (!existsSync(absolute)) throw new Error('File has not been created yet.')
    shell.showItemInFolder(absolute)
  })

  ipcMain.handle(CH.sessionCreate, (_event, input) => sessions.create(input))
  ipcMain.handle(CH.sessionSend, (_event, tabId: string, text: string) => sessions.start(tabId, text))
  ipcMain.handle(CH.sessionStop, (_event, tabId: string) => sessions.stop(tabId))
  ipcMain.handle(CH.sessionClose, (_event, tabId: string) => sessions.close(tabId))
  ipcMain.handle(CH.sessionSetMode, (_event, tabId: string, mode) => sessions.setMode(tabId, mode))

  ipcMain.handle(CH.permissionDecision, (_event, decision: PermissionDecision) => {
    permissions.decide(decision)
  })

  ipcMain.handle(CH.terminalCreate, (_event, input: TerminalCreateInput) => terminal.create(input))
  ipcMain.on(CH.terminalWrite, (_event, id: string, data: string) => terminal.write(id, data))
  ipcMain.on(CH.terminalResize, (_event, id: string, cols: number, rows: number) =>
    terminal.resize(id, cols, rows)
  )
  ipcMain.handle(CH.terminalKill, (_event, id: string) => terminal.kill(id))

  ipcMain.handle(CH.providerDelegateStart, (_event, request: DelegateRequest) => providers.start(request))
  ipcMain.handle(CH.providerDelegateCancel, (_event, requestId: string) => providers.cancel(requestId))
  ipcMain.handle(CH.providerTest, (_event, provider, overrides) => providers.test(provider, overrides))

  ipcMain.handle(CH.loopStart, (_event, config: LoopConfig) => loop.start(config))
  ipcMain.handle(CH.loopPause, () => loop.pause())
  ipcMain.handle(CH.loopResume, () => loop.resume())
  ipcMain.handle(CH.loopStop, () => loop.stop())
  ipcMain.handle(CH.loopState, () => loop.getState())

  ipcMain.handle(CH.shellOpenPath, async (_event, path: string) => {
    const absolute = insideWorkspace(path)
    return shell.openPath(absolute)
  })
  ipcMain.handle(CH.shellShowItem, (_event, path: string) => {
    shell.showItemInFolder(insideWorkspace(path))
  })
  ipcMain.handle(CH.shellOpenExternal, async (_event, url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) links can be opened.')
    await shell.openExternal(parsed.toString())
  })
}
