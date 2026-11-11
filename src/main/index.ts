import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron'
import { join } from 'node:path'
import type { WorkspaceHost } from './host/host'
import { HostRegistry } from './host/registry'
import { registerIpc } from './ipc'
import type { EventSenders } from './ipc/registry'
import { AgentFactory } from './services/agents'
import { ConsultService } from './services/consult'
import { GitService } from './services/git'
import { OmpService } from './services/omp'
import { PlanService } from './services/plan'
import { SessionManager } from './services/sessions'
import { SettingsService } from './services/settings'
import { TaskLoopService } from './services/task-loop'
import { TerminalService } from './services/terminal'
import { UiBroker } from './services/ui-broker'
import { LoginShare } from './services/login-share'
import { WorkspaceGate } from './services/workspace-gate'
import { WorkspaceService } from './services/workspace'

let mainWindow: BrowserWindow | null = null
let cleanup: (() => Promise<void>) | null = null
let windowHook: ((window: BrowserWindow) => void) | undefined

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    app.setName('ProHarness')
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write')
    })

    const dataDir = app.getPath('userData')

    const settings = new SettingsService()
    const registry = new HostRegistry()
    const gate = new WorkspaceGate()
    const activeHost = (): WorkspaceHost => registry.get(settings.workspaceHost)
    let loginShare: LoginShare
    const omp = new OmpService(
      () => settings.ompPath,
      () => settings.workspacePath,
      join(dataDir, 'omp-status.json'),
      activeHost,
      (host) => loginShare.prelude(host)
    )
    // Shares this Mac's omp logins with SSH hosts that opt in.
    loginShare = new LoginShare(
      () => omp.binary(registry.local),
      (hostId) => settings.sharesLogins(hostId)
    )
    const plan = new PlanService(activeHost, () => settings.workspacePath)
    const git = new GitService(activeHost, () => settings.workspacePath)
    const broker = new UiBroker()
    const agents = new AgentFactory(settings, omp, plan, git, broker, activeHost)
    const sessions = new SessionManager(settings, agents, broker, activeHost, gate)
    const consult = new ConsultService(agents, git, gate)
    const terminal = new TerminalService(
      () => settings.workspacePath,
      () => settings.terminalShell,
      activeHost,
      gate
    )
    const loop = new TaskLoopService(plan, git, agents, gate)

    let events: EventSenders

    const workspace = new WorkspaceService({
      settings,
      registry,
      omp,
      loginShare,
      loop,
      consult,
      broker,
      sessions,
      terminal,
      plan,
      git,
      gate,
      onGoals: (goals) => events.goals.onChanged(goals),
      onGit: (summary) => events.git.onChanged(summary)
    })

    events = registerIpc({
      getWindow: () => mainWindow,
      appVersion: app.getVersion(),
      settings,
      registry,
      loginShare,
      omp,
      plan,
      git,
      sessions,
      broker,
      terminal,
      consult,
      loop,
      workspace
    })

    sessions.setEmitter((tabId, event) => events.sessions.onEvent(tabId, event))
    broker.setEmitters(
      (request) => events.ui.onRequest(request),
      (requestId) => events.ui.onResolved(requestId)
    )
    terminal.setEmitter(
      (event) => events.terminal.onData(event),
      (event) => events.terminal.onExit(event)
    )
    consult.setEmitter((event) => events.consult.onEvent(event))
    loop.setEmitter((event) => events.loop.onEvent(event))
    // Re-check this host's saved model choices whenever its catalog changes.
    const applyCatalog = (): void => {
      const status = omp.current()
      if (status.hostId !== settings.workspaceHost) return
      settings.resolveFor(status.models, status.defaultModel)
      events.settings.onChanged(settings.publicSettings())
    }
    omp.onChange((status) => {
      events.omp.onChanged(status)
      applyCatalog()
    })
    applyCatalog()
    plan.onChange((goals) => events.goals.onChanged(goals))
    git.onChanged((summary) => events.git.onChanged(summary))

    buildMenu()
    createWindow((window) => {
      // A reload or crash orphans every tab, so close their omp processes.
      window.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
          void workspace.restartAgents().catch((error) => console.error('Restart agents failed:', error))
        }
      })
      window.webContents.on('render-process-gone', () => {
        void workspace.restartAgents().catch((error) => console.error('Restart agents failed:', error))
      })
    })
    void omp.refresh()

    cleanup = async (): Promise<void> => {
      try {
        // The quit race expires after 5 s; leave time for the synchronous teardown below.
        await Promise.race([workspace.restartAgents(), delay(3_500)])
      } catch (error) {
        console.error('Restart agents failed:', error)
      } finally {
        loop.dispose()
        plan.dispose()
        git.dispose()
        loginShare.dispose()
        registry.dispose()
      }
    }
  }).catch((error: Error) => {
    dialog.showErrorBox('ProHarness could not start', error.message)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(windowHook)
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => app.quit())
  }

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting || !cleanup) return
    event.preventDefault()
    quitting = true
    const run = cleanup
    cleanup = null
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    void Promise.race([run(), timeout])
      .catch((error) => console.error('Cleanup failed:', error))
      .finally(() => app.quit())
  })
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload', visible: !app.isPackaged },
        { role: 'toggleDevTools', visible: !app.isPackaged },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(onCreate?: (window: BrowserWindow) => void): void {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#100f0d',
    title: 'ProHarness',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  onCreate?.(mainWindow)
  windowHook = onCreate || windowHook
  mainWindow.once('ready-to-show', () => mainWindow?.show())
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

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}
