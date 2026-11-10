import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type {
  PermissionMode,
  SessionCreateInput,
  SessionEvent,
  SessionRuntime
} from '@shared/types'
import type { ClaudeService } from './claude'
import type { GitService } from './git'
import type { PlanService } from './plan'
import type { ProviderService } from './providers'
import type { SettingsService } from './settings'

interface RuntimeSession {
  tabId: string
  cwd: string
  title: string
  model: string
  permissionMode: PermissionMode
  kind: 'chat' | 'loop'
  sdkSessionId: string | null
  createdAt: number
  busy: boolean
  abortController: AbortController | null
  alwaysAllowed: Set<string>
}

const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/

export class SessionManager {
  private sessions = new Map<string, RuntimeSession>()
  private emit: (tabId: string, event: SessionEvent) => void = () => undefined

  constructor(
    private readonly settings: SettingsService,
    private readonly claude: ClaudeService,
    private readonly plan: PlanService,
    private readonly git: GitService,
    private readonly providers: ProviderService
  ) {}

  setEmitter(emitter: (tabId: string, event: SessionEvent) => void): void {
    this.emit = emitter
  }

  private validateCwd(cwd: string): string {
    const workspace = resolve(this.settings.workspacePath)
    const target = resolve(cwd || workspace)
    if (target !== workspace && !target.startsWith(`${workspace}${sep}`)) {
      throw new Error('Sessions must run inside the current workspace.')
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      throw new Error('Session working directory does not exist.')
    }
    return target
  }

  create(input: SessionCreateInput): SessionRuntime {
    if (!TAB_ID_RE.test(input.tabId)) throw new Error('Invalid session id.')
    const existing = this.sessions.get(input.tabId)
    if (existing) return this.runtime(existing)
    const cwd = this.validateCwd(input.cwd || this.settings.workspacePath)
    const session: RuntimeSession = {
      tabId: input.tabId,
      cwd,
      title: input.title || 'Untitled session',
      model: input.model?.trim() || this.settings.claudeModel,
      permissionMode: input.permissionMode || this.settings.permissionMode,
      kind: input.kind || 'chat',
      sdkSessionId: null,
      createdAt: Date.now(),
      busy: false,
      abortController: null,
      alwaysAllowed: new Set()
    }
    this.sessions.set(input.tabId, session)
    this.emit(input.tabId, { type: 'status', status: 'idle' })
    return this.runtime(session)
  }

  private runtime(session: RuntimeSession): SessionRuntime {
    return {
      tabId: session.tabId,
      sdkSessionId: session.sdkSessionId,
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      kind: session.kind,
      createdAt: session.createdAt
    }
  }

  get(tabId: string): SessionRuntime | null {
    const session = this.sessions.get(tabId)
    return session ? this.runtime(session) : null
  }

  setMode(tabId: string, mode: PermissionMode | undefined): void {
    const session = this.sessions.get(tabId)
    if (!session || !mode) return
    session.permissionMode = mode
  }

  setModel(tabId: string, model: string): void {
    const session = this.sessions.get(tabId)
    if (!session || !model.trim()) return
    session.model = model.trim()
  }

  async send(tabId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(tabId)
    if (!session) throw new Error('This session no longer exists. Open a new tab.')
    if (!prompt.trim()) throw new Error('Type a message before sending.')
    if (session.busy) throw new Error('This session is already working on a turn.')

    session.busy = true
    const abortController = new AbortController()
    session.abortController = abortController
    this.emit(tabId, { type: 'status', status: 'thinking' })

    try {
      const result = await this.claude.runTurn({
        cwd: session.cwd,
        prompt,
        resume: session.sdkSessionId,
        model: session.model,
        permissionMode: session.permissionMode,
        origin: 'session',
        originId: tabId,
        originLabel: session.title,
        autoApprove: session.permissionMode === 'bypassPermissions',
        alwaysAllowed: session.alwaysAllowed,
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === 'init') {
            session.sdkSessionId = event.sdkSessionId || session.sdkSessionId
          }
          if (event.type === 'result') {
            this.emit(tabId, { type: 'status', status: 'idle' })
          }
          this.emit(tabId, event)
        },
        title: session.title,
        planService: this.plan,
        gitService: this.git,
        providerService: this.providers,
        defaultReviewer: () => this.settings.defaultReviewer,
        defaultReviewerModel: () => this.settings.defaultReviewerModel,
        claudeApiKey: this.settings.getClaudeApiKey(),
        executablePath: this.settings.claudeExecutablePath
      })
      if (result.sdkSessionId) session.sdkSessionId = result.sdkSessionId
    } catch (error) {
      this.emit(tabId, {
        type: 'error',
        message: (error as Error).message || 'The session failed.'
      })
    } finally {
      session.busy = false
      if (session.abortController === abortController) session.abortController = null
      this.emit(tabId, { type: 'status', status: 'idle' })
    }
  }

  stop(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.emit(tabId, { type: 'status', status: 'stopping' })
    session.abortController?.abort()
  }

  close(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    session.abortController?.abort()
    this.sessions.delete(tabId)
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.abortController?.abort()
    this.sessions.clear()
  }
}
