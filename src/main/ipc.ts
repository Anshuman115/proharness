import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { resolve, sep } from 'node:path'
import { CH } from '@shared/channels'
import type { ConsultRequest, LoopConfig, SessionCreateInput, SettingsPatch, TerminalCreateInput, ThinkingLevel, UiResponse } from '@shared/types'
import type { ConsultService } from './services/consult'
import type { GitService } from './services/git'
import type { OmpService } from './services/omp'
import type { PlanService } from './services/plan'
import type { SessionManager } from './services/sessions'
import type { SettingsService } from './services/settings'
import type { TaskLoopService } from './services/task-loop'
import type { TerminalService } from './services/terminal'
import type { UiBroker } from './services/ui-broker'

export interface IpcDependencies {
  getWindow: () => BrowserWindow | null
  appVersion: string
  settings: SettingsService
  omp: OmpService
  plan: PlanService
  git: GitService
  sessions: SessionManager
  broker: UiBroker
  terminal: TerminalService
  consult: ConsultService
  loop: TaskLoopService
}

export function registerIpc(deps: IpcDependencies): void {
  const { getWindow, settings, omp, plan, git, sessions, broker, terminal, consult, loop } = deps

  const send = (channel: string, ...args: unknown[]): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }

  const insideWorkspace = (input: string): string => {
    const root = resolve(settings.workspacePath)
    const target = resolve(root, input)
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Path is outside the workspace.')
    return target
  }

  const onWorkspaceChange = async (previous: string): Promise<void> => {
    if (previous === settings.workspacePath) return
    await loop.stop()
    broker.cancelAll()
    await sessions.dispose()
    terminal.dispose()
    plan.resetWatching()
    git.resetWatching()
    send(CH.goalsChanged, plan.listGoals())
    send(CH.gitChanged, await git.summary())
  }

  const pick = async (options: Electron.OpenDialogOptions): Promise<string | null> => {
    const window = getWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  }

  ipcMain.handle(CH.bootstrap, async () => ({
    settings: settings.publicSettings(),
    goals: plan.listGoals(),
    git: await git.summary(),
    omp: omp.current(),
    appVersion: deps.appVersion,
    platform: process.platform
  }))

  ipcMain.handle(CH.settingsUpdate, async (_event, patch: SettingsPatch) => {
    const previous = settings.workspacePath
    const previousOmp = settings.ompPath
    const next = settings.update(patch)
    await onWorkspaceChange(previous)
    if (previousOmp !== settings.ompPath) void omp.refresh()
    return next
  })

  ipcMain.handle(CH.settingsChooseWorkspace, async () => {
    const path = await pick({
      title: 'Choose a project folder',
      defaultPath: settings.workspacePath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (!path) return null
    const previous = settings.workspacePath
    const next = settings.update({ workspacePath: path })
    await onWorkspaceChange(previous)
    return next
  })

  ipcMain.handle(CH.settingsChooseOmp, () => pick({ title: 'Choose the omp executable', properties: ['openFile'] }))

  ipcMain.handle(CH.ompRefresh, () => omp.refresh())

  ipcMain.handle(CH.goalsList, () => plan.listGoals())
  ipcMain.handle(CH.goalsInit, async () => {
    plan.ensureRoot()
    plan.resetWatching()
    const { tracked } = await git.excludeGoals()
    send(CH.goalsChanged, plan.listGoals())
    return { root: plan.goalsRoot, tracked }
  })
  ipcMain.handle(CH.goalsCreate, async (_event, title: string) => {
    const summary = plan.createGoal(title)
    await git.excludeGoals()
    send(CH.goalsChanged, plan.listGoals())
    return summary
  })
  ipcMain.handle(CH.goalsRead, (_event, goalId: string) => plan.readGoal(goalId))
  ipcMain.handle(CH.goalsToggleTask, (_event, goalId: string, taskId: string, checked: boolean) => {
    const detail = plan.setTaskChecked(goalId, taskId, checked)
    send(CH.goalsChanged, plan.listGoals())
    return detail
  })

  ipcMain.handle(CH.gitSummary, () => git.summary())
  ipcMain.handle(CH.gitDiff, (_event, path: string) => git.fileDiff(path))
  ipcMain.handle(CH.gitCommits, () => git.recentCommits())
  ipcMain.handle(CH.gitRestore, async (_event, path: string) => {
    const summary = await git.restoreFile(path)
    send(CH.gitChanged, summary)
    return summary
  })

  ipcMain.handle(CH.sessionCreate, (_event, input: SessionCreateInput) => sessions.create(input))
  ipcMain.handle(CH.sessionSend, (_event, tabId: string, text: string, behavior?: 'steer' | 'followUp') =>
    sessions.send(tabId, text, behavior)
  )
  ipcMain.handle(CH.sessionStop, (_event, tabId: string) => sessions.stop(tabId))
  ipcMain.handle(CH.sessionClose, (_event, tabId: string) => sessions.close(tabId))
  ipcMain.handle(CH.sessionSetModel, (_event, tabId: string, model: string) => sessions.setModel(tabId, model))
  ipcMain.handle(CH.sessionSetThinking, (_event, tabId: string, level: ThinkingLevel) => sessions.setThinking(tabId, level))
  ipcMain.handle(CH.sessionNew, (_event, tabId: string) => sessions.newConversation(tabId))
  ipcMain.handle(CH.sessionResume, (_event, tabId: string, file: string) => sessions.resume(tabId, file))
  ipcMain.handle(CH.sessionCompact, (_event, tabId: string) => sessions.compact(tabId))
  ipcMain.handle(CH.sessionRemoveQueued, (_event, tabId: string, message: string, queue: 'steering' | 'followUp') =>
    sessions.removeQueued(tabId, message, queue)
  )
  ipcMain.handle(CH.sessionRecent, () => sessions.recent())
  ipcMain.handle(CH.sessionRename, (_event, tabId: string, title: string) => sessions.rename(tabId, title))

  ipcMain.handle(CH.uiResponse, (_event, response: UiResponse) => broker.respond(response))

  ipcMain.handle(CH.terminalCreate, (_event, input: TerminalCreateInput) => terminal.create(input))
  ipcMain.on(CH.terminalWrite, (_event, id: string, data: string) => terminal.write(id, data))
  ipcMain.on(CH.terminalResize, (_event, id: string, cols: number, rows: number) => terminal.resize(id, cols, rows))
  ipcMain.handle(CH.terminalKill, (_event, id: string) => terminal.kill(id))

  ipcMain.handle(CH.consultStart, (_event, request: ConsultRequest) => consult.start(request))
  ipcMain.handle(CH.consultCancel, (_event, requestId: string) => consult.cancel(requestId))

  ipcMain.handle(CH.loopStart, (_event, config: LoopConfig) => loop.start(config))
  ipcMain.handle(CH.loopPause, () => loop.pause())
  ipcMain.handle(CH.loopResume, () => loop.resume())
  ipcMain.handle(CH.loopStop, () => loop.stop())
  ipcMain.handle(CH.loopState, () => loop.getState())

  ipcMain.handle(CH.shellOpenPath, (_event, path: string) => shell.openPath(insideWorkspace(path)))
  ipcMain.handle(CH.shellShowItem, (_event, path: string) => shell.showItemInFolder(insideWorkspace(path)))
  ipcMain.handle(CH.shellOpenExternal, async (_event, url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) links can be opened.')
    await shell.openExternal(parsed.toString())
  })
}
