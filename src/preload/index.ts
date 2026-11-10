import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '@shared/channels'
import type { ProHarnessApi } from '@shared/api'
import type {
  DelegateEvent,
  GitSummary,
  GoalSummary,
  LoopEvent,
  PermissionRequest,
  SessionEvent,
  TerminalDataEvent,
  TerminalExitEvent
} from '@shared/types'

function subscribe<T extends unknown[]>(
  channel: string,
  listener: (...args: T) => void
): () => void {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    listener(...(args as T))
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: ProHarnessApi = {
  bootstrap: () => ipcRenderer.invoke(CH.bootstrap),
  appInfo: () => ipcRenderer.invoke(CH.appInfo),

  settings: {
    update: (patch) => ipcRenderer.invoke(CH.settingsUpdate, patch),
    chooseWorkspace: () => ipcRenderer.invoke(CH.settingsChooseWorkspace),
    chooseClaudeExecutable: () => ipcRenderer.invoke(CH.settingsChooseExecutable)
  },

  goals: {
    list: () => ipcRenderer.invoke(CH.goalsList),
    read: (goalId) => ipcRenderer.invoke(CH.goalsRead, goalId),
    toggleTask: (goalId, taskId, checked) =>
      ipcRenderer.invoke(CH.goalsToggleTask, goalId, taskId, checked),
    onChanged: (listener) => subscribe<[GoalSummary[]]>(CH.goalsChanged, listener)
  },

  git: {
    summary: () => ipcRenderer.invoke(CH.gitSummary),
    fileDiff: (path) => ipcRenderer.invoke(CH.gitDiff, path),
    restore: (path) => ipcRenderer.invoke(CH.gitRestore, path),
    reveal: (path) => ipcRenderer.invoke(CH.gitReveal, path),
    onChanged: (listener) => subscribe<[GitSummary]>(CH.gitChanged, listener)
  },

  sessions: {
    create: (input) => ipcRenderer.invoke(CH.sessionCreate, input),
    send: (tabId, text) => ipcRenderer.invoke(CH.sessionSend, tabId, text),
    stop: (tabId) => ipcRenderer.invoke(CH.sessionStop, tabId),
    close: (tabId) => ipcRenderer.invoke(CH.sessionClose, tabId),
    setMode: (tabId, mode) => ipcRenderer.invoke(CH.sessionSetMode, tabId, mode),
    onEvent: (listener) => subscribe<[string, SessionEvent]>(CH.sessionEvent, listener)
  },

  permissions: {
    respond: (decision) => ipcRenderer.invoke(CH.permissionDecision, decision),
    onRequest: (listener) => subscribe<[PermissionRequest]>(CH.permissionRequest, listener),
    onResolved: (listener) => subscribe<[string, boolean]>(CH.permissionResolved, listener)
  },

  terminal: {
    create: (input) => ipcRenderer.invoke(CH.terminalCreate, input),
    write: (id, data) => ipcRenderer.send(CH.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(CH.terminalResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(CH.terminalKill, id),
    onData: (listener) => subscribe<[TerminalDataEvent]>(CH.terminalData, listener),
    onExit: (listener) => subscribe<[TerminalExitEvent]>(CH.terminalExit, listener)
  },

  providers: {
    delegate: (request) => ipcRenderer.invoke(CH.providerDelegateStart, request),
    cancel: (requestId) => ipcRenderer.invoke(CH.providerDelegateCancel, requestId),
    test: (provider, model) => ipcRenderer.invoke(CH.providerTest, provider, model),
    onEvent: (listener) => subscribe<[DelegateEvent]>(CH.delegateEvent, listener)
  },

  loop: {
    start: (config) => ipcRenderer.invoke(CH.loopStart, config),
    pause: () => ipcRenderer.invoke(CH.loopPause),
    resume: () => ipcRenderer.invoke(CH.loopResume),
    stop: () => ipcRenderer.invoke(CH.loopStop),
    state: () => ipcRenderer.invoke(CH.loopState),
    onEvent: (listener) => subscribe<[LoopEvent]>(CH.loopEvent, listener)
  },

  shell: {
    openPath: (path) => ipcRenderer.invoke(CH.shellOpenPath, path),
    showItem: (path) => ipcRenderer.invoke(CH.shellShowItem, path),
    openExternal: (url) => ipcRenderer.invoke(CH.shellOpenExternal, url)
  }
}

contextBridge.exposeInMainWorld('proharness', api)
