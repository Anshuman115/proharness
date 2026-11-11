import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import { registerIpc } from './ipc'
import { ClaudeService } from './services/claude'
import { GitService } from './services/git'
import { PermissionBroker } from './services/permissions'
import { PlanService } from './services/plan'
import { ProviderService } from './services/providers'
import { SessionManager } from './services/sessions'
import { SettingsService } from './services/settings'
import { TaskLoopService } from './services/task-loop'
import { TerminalService } from './services/terminal'

let mainWindow: BrowserWindow | null = null
let cleanup: (() => void) | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    app.setName('ProHarness')
    app.setAppUserModelId('dev.proharness.app')

    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write')
    })

    const settings = new SettingsService()
    const plan = new PlanService(() => settings.workspacePath)
    const git = new GitService(() => settings.workspacePath)
    const providers = new ProviderService(settings)
    const permissions = new PermissionBroker()
    const claude = new ClaudeService(permissions)
    const sessions = new SessionManager(settings, claude, plan, git, providers)
    const terminal = new TerminalService(
      () => settings.workspacePath,
      () => settings.terminalShell
    )
    const loop = new TaskLoopService(settings, plan, git, providers, claude)

    const send = (channel: string, ...args: unknown[]): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
    }

    providers.setEmitter((event) => send(CH.delegateEvent, event))
    sessions.setEmitter((tabId, event) => send(CH.sessionEvent, tabId, event))
    permissions.setEmitters(
      (request) => send(CH.permissionRequest, request),
      (requestId, allow) => send(CH.permissionResolved, requestId, allow)
    )
    terminal.setEmitter(
      (event) => send(CH.terminalData, event),
      (event) => send(CH.terminalExit, event)
    )
    loop.setEmitter((event) => send(CH.loopEvent, event))
    plan.onChange((goals) => send(CH.goalsChanged, goals))
    git.onChanged((summary) => send(CH.gitChanged, summary))

    registerIpc({
      getWindow: () => mainWindow,
      settings,
      plan,
      git,
      providers,
      sessions,
      permissions,
      terminal,
      loop
    })

    createWindow()

    cleanup = (): void => {
      permissions.denyAll('The application is closing.')
      providers.dispose()
      loop.dispose()
      sessions.dispose()
      terminal.dispose()
      plan.dispose()
      git.dispose()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    cleanup?.()
    cleanup = null
  })
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1510,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0c0b09',
    title: 'ProHarness',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (current && url !== current) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
