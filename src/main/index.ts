import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/channels'
import type { WorkspaceHost } from './host/host'
import { HostRegistry } from './host/registry'
import { registerIpc } from './ipc'
import { shellEnv } from './omp/env'
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
import { brokerEnvScript, LoginShare } from './services/login-share'
import type { SshHost } from './host/ssh'

let mainWindow: BrowserWindow | null = null
let cleanup: (() => Promise<void>) | null = null
let windowHook: ((window: BrowserWindow) => void) | undefined

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
    let resolvedEnv: NodeJS.ProcessEnv = process.env
    void shellEnv().then((env) => {
      resolvedEnv = env
    })

    const settings = new SettingsService()
    const registry = new HostRegistry(() => shellEnv())
    const activeHost = (): WorkspaceHost => registry.get(settings.workspaceHost)
    const omp = new OmpService(
      () => settings.ompPath,
      () => settings.workspacePath,
      join(dataDir, 'omp-status.json'),
      activeHost
    )
    // Shares this Mac's omp logins with SSH hosts that opt in.
    const loginShare = new LoginShare(() => omp.binary(registry.local), () => omp.env())
    let shareError: string | null = null
    omp.prepareHost = async (host) => {
      const ssh = host as SshHost
      if (!settings.sharesLogins(host.id)) {
        ssh.spawnPrefix = ''
        return
      }
      try {
        const port = await loginShare.attach(ssh)
        ssh.spawnPrefix = brokerEnvScript(port)
        shareError = null
      } catch (error) {
        // Fall back to the host's own logins rather than failing the spawn.
        ssh.spawnPrefix = ''
        shareError = (error as Error).message
      }
    }
    const plan = new PlanService(activeHost, () => settings.workspacePath)
    const git = new GitService(activeHost, () => settings.workspacePath)
    const broker = new UiBroker()
    const sessions = new SessionManager(settings, omp, plan, git, broker, dataDir, activeHost)
    const agents = new AgentFactory(
      settings,
      omp,
      plan,
      git,
      broker,
      (host) => sessions.overlayFor(host),
      activeHost
    )
    const consult = new ConsultService(agents, git)
    const terminal = new TerminalService(
      () => settings.workspacePath,
      () => settings.terminalShell,
      activeHost,
      () => resolvedEnv
    )
    const loop = new TaskLoopService(plan, git, agents)

    const send = (channel: string, ...args: unknown[]): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
    }

    sessions.setEmitter((tabId, event) => send(CH.sessionEvent, tabId, event))
    broker.setEmitters(
      (request) => send(CH.uiRequest, request),
      (requestId) => send(CH.uiResolved, requestId)
    )
    terminal.setEmitter(
      (event) => send(CH.terminalData, event),
      (event) => send(CH.terminalExit, event)
    )
    consult.setEmitter((event) => send(CH.consultEvent, event))
    loop.setEmitter((event) => send(CH.loopEvent, event))
    // Re-check this host's saved model choices whenever its catalog changes.
    const applyCatalog = (): void => {
      const status = omp.current()
      if (status.hostId !== settings.workspaceHost) return
      settings.resolveFor(status.models, status.defaultModel)
      send(CH.settingsChanged, settings.publicSettings())
    }
    omp.onChange((status) => {
      send(CH.ompChanged, status)
      applyCatalog()
    })
    applyCatalog()
    plan.onChange((goals) => send(CH.goalsChanged, goals))
    git.onChanged((summary) => send(CH.gitChanged, summary))

    registerIpc({
      getWindow: () => mainWindow,
      appVersion: app.getVersion(),
      settings,
      registry,
      loginShare,
      shareError: () => shareError,
      omp,
      plan,
      git,
      sessions,
      broker,
      terminal,
      consult,
      loop
    })

    buildMenu()
    createWindow((window) => {
      // A reload or crash orphans every tab, so close their omp processes.
      window.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
          broker.cancelAll()
          void sessions.dispose()
        }
      })
      window.webContents.on('render-process-gone', () => {
        broker.cancelAll()
        void sessions.dispose()
      })
    })
    void omp.refresh()

    cleanup = async (): Promise<void> => {
      broker.cancelAll()
      consult.dispose()
      loop.dispose()
      terminal.dispose()
      plan.dispose()
      git.dispose()
      loginShare.dispose()
      registry.dispose()
      await sessions.dispose()
    }
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
