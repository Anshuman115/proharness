import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '@shared/channels'
import type { ProHarnessApi } from '@shared/api'
import type {
  ConsultEvent,
  GitSummary,
  GoalSummary,
  LoopEvent,
  OmpStatus,
  PublicSettings,
  SessionEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  UiRequest
} from '@shared/types'

function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    listener(...(args as T))
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: ProHarnessApi = {
  bootstrap: () => ipcRenderer.invoke(CH.bootstrap),

  settings: {
    update: (patch) => ipcRenderer.invoke(CH.settingsUpdate, patch),
    chooseWorkspace: () => ipcRenderer.invoke(CH.settingsChooseWorkspace),
    chooseOmp: () => ipcRenderer.invoke(CH.settingsChooseOmp),
    onChanged: (listener) => subscribe<[PublicSettings]>(CH.settingsChanged, listener)
  },

  workspace: {
    open: (ref) => ipcRenderer.invoke(CH.workspaceOpen, ref),
    sshHosts: () => ipcRenderer.invoke(CH.workspaceSshHosts),
    listDir: (host, path) => ipcRenderer.invoke(CH.workspaceListDir, host, path)
  },

  omp: {
    refresh: () => ipcRenderer.invoke(CH.ompRefresh),
    onChanged: (listener) => subscribe<[OmpStatus]>(CH.ompChanged, listener)
  },

  goals: {
    list: () => ipcRenderer.invoke(CH.goalsList),
    init: () => ipcRenderer.invoke(CH.goalsInit),
    create: (title) => ipcRenderer.invoke(CH.goalsCreate, title),
    read: (goalId) => ipcRenderer.invoke(CH.goalsRead, goalId),
    toggleTask: (goalId, taskId, checked) => ipcRenderer.invoke(CH.goalsToggleTask, goalId, taskId, checked),
    onChanged: (listener) => subscribe<[GoalSummary[]]>(CH.goalsChanged, listener)
  },

  git: {
    summary: () => ipcRenderer.invoke(CH.gitSummary),
    fileDiff: (path) => ipcRenderer.invoke(CH.gitDiff, path),
    restore: (path) => ipcRenderer.invoke(CH.gitRestore, path),
    commits: () => ipcRenderer.invoke(CH.gitCommits),
    onChanged: (listener) => subscribe<[GitSummary]>(CH.gitChanged, listener)
  },

  sessions: {
    create: (input) => ipcRenderer.invoke(CH.sessionCreate, input),
    send: (tabId, text, behavior) => ipcRenderer.invoke(CH.sessionSend, tabId, text, behavior),
    stop: (tabId) => ipcRenderer.invoke(CH.sessionStop, tabId),
    close: (tabId) => ipcRenderer.invoke(CH.sessionClose, tabId),
    setModel: (tabId, model) => ipcRenderer.invoke(CH.sessionSetModel, tabId, model),
    setThinking: (tabId, level) => ipcRenderer.invoke(CH.sessionSetThinking, tabId, level),
    newConversation: (tabId) => ipcRenderer.invoke(CH.sessionNew, tabId),
    resume: (tabId, file) => ipcRenderer.invoke(CH.sessionResume, tabId, file),
    compact: (tabId) => ipcRenderer.invoke(CH.sessionCompact, tabId),
    removeQueued: (tabId, message, queue) => ipcRenderer.invoke(CH.sessionRemoveQueued, tabId, message, queue),
    recent: () => ipcRenderer.invoke(CH.sessionRecent),
    rename: (tabId, title) => ipcRenderer.invoke(CH.sessionRename, tabId, title),
    onEvent: (listener) => subscribe<[string, SessionEvent]>(CH.sessionEvent, listener)
  },

  ui: {
    respond: (response) => ipcRenderer.invoke(CH.uiResponse, response),
    onRequest: (listener) => subscribe<[UiRequest]>(CH.uiRequest, listener),
    onResolved: (listener) => subscribe<[string]>(CH.uiResolved, listener)
  },

  terminal: {
    create: (input) => ipcRenderer.invoke(CH.terminalCreate, input),
    write: (id, data) => ipcRenderer.send(CH.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(CH.terminalResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(CH.terminalKill, id),
    onData: (listener) => subscribe<[TerminalDataEvent]>(CH.terminalData, listener),
    onExit: (listener) => subscribe<[TerminalExitEvent]>(CH.terminalExit, listener)
  },

  consult: {
    start: (request) => ipcRenderer.invoke(CH.consultStart, request),
    cancel: (requestId) => ipcRenderer.invoke(CH.consultCancel, requestId),
    onEvent: (listener) => subscribe<[ConsultEvent]>(CH.consultEvent, listener)
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
