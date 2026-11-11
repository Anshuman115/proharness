import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { app } from 'electron'
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type PublicSettings,
  type SettingsPatch,
  type WorkspaceRef
} from '@shared/types'

interface StoredSettings {
  version: 2
  workspacePath: string
  workspaceHost: string
  recentWorkspaces: WorkspaceRef[]
  ompPath: string
  chatModel: string
  chatApproval: ApprovalMode
  implementerModel: string
  reviewerModel: string
  loopApproval: ApprovalMode
  pinnedModels: string[]
  terminalShell: string
  reduceMotion: boolean
}

const MAX_RECENT_WORKSPACES = 12

/** Shown first in model pickers. Everything else omp knows stays searchable. */
export const DEFAULT_PINNED = [
  'anthropic/claude-opus-5-5',
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-haiku-5-5',
  'openai-codex/gpt-6.1-sol',
  'openai-codex/gpt-6.1-terra',
  'openai-codex/gpt-6-luna',
  'commandcode/deepseek/deepseek-v4.1-flash'
]

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function approval(value: unknown, fallback: ApprovalMode): ApprovalMode {
  return APPROVAL_MODES.includes(value as ApprovalMode) ? (value as ApprovalMode) : fallback
}

function cleanModel(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanWorkspaceRef(value: unknown): WorkspaceRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (!host || !path) return null
  return { host, path }
}

export class SettingsService {
  readonly filePath: string
  private settings: StoredSettings

  constructor(filePath = join(app.getPath('userData'), 'settings.json')) {
    this.filePath = filePath
    this.settings = this.load()
  }

  private defaultWorkspace(): string {
    const candidates = [process.env.PROHARNESS_WORKSPACE, app.isPackaged ? null : app.getAppPath()]
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate
    }
    return app.getPath('home')
  }

  private defaults(): StoredSettings {
    return {
      version: 2,
      workspacePath: this.defaultWorkspace(),
      workspaceHost: 'local',
      recentWorkspaces: [],
      ompPath: process.env.PROHARNESS_OMP || '',
      chatModel: '',
      chatApproval: 'write',
      implementerModel: '',
      reviewerModel: 'anthropic/claude-sonnet-5-5',
      loopApproval: 'yolo',
      pinnedModels: [...DEFAULT_PINNED],
      terminalShell: process.env.SHELL || '/bin/zsh',
      reduceMotion: false
    }
  }

  private load(): StoredSettings {
    const defaults = this.defaults()
    const stored = readJson<Record<string, unknown>>(this.filePath)
    if (!stored) return defaults
    const workspaceHost =
      typeof stored.workspaceHost === 'string' && stored.workspaceHost.trim()
        ? stored.workspaceHost.trim()
        : defaults.workspaceHost
    // A remote path is resolved on the server, so it need not exist locally.
    const workspace =
      typeof stored.workspacePath === 'string' &&
      (workspaceHost !== 'local' || existsSync(stored.workspacePath))
    return {
      version: 2,
      workspacePath: workspace ? (stored.workspacePath as string) : defaults.workspacePath,
      workspaceHost,
      recentWorkspaces: Array.isArray(stored.recentWorkspaces)
        ? (stored.recentWorkspaces as unknown[])
            .map((item) => cleanWorkspaceRef(item))
            .filter((item): item is WorkspaceRef => item !== null)
            .slice(0, MAX_RECENT_WORKSPACES)
        : defaults.recentWorkspaces,
      ompPath: typeof stored.ompPath === 'string' ? stored.ompPath : defaults.ompPath,
      chatModel: cleanModel(stored.chatModel),
      chatApproval: approval(stored.chatApproval, defaults.chatApproval),
      implementerModel: cleanModel(stored.implementerModel),
      reviewerModel: cleanModel(stored.reviewerModel) || defaults.reviewerModel,
      loopApproval: approval(stored.loopApproval, defaults.loopApproval),
      pinnedModels: Array.isArray(stored.pinnedModels)
        ? (stored.pinnedModels as unknown[]).map(cleanModel).filter(Boolean)
        : defaults.pinnedModels,
      terminalShell: typeof stored.terminalShell === 'string' && stored.terminalShell ? stored.terminalShell : defaults.terminalShell,
      reduceMotion: Boolean(stored.reduceMotion)
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Best effort.
    }
  }

  get workspacePath(): string {
    return this.settings.workspacePath
  }
  get workspaceHost(): string {
    return this.settings.workspaceHost
  }
  get ompPath(): string {
    return this.settings.ompPath
  }
  get chatModel(): string {
    return this.settings.chatModel
  }
  get chatApproval(): ApprovalMode {
    return this.settings.chatApproval
  }
  get implementerModel(): string {
    return this.settings.implementerModel
  }
  get reviewerModel(): string {
    return this.settings.reviewerModel
  }
  get loopApproval(): ApprovalMode {
    return this.settings.loopApproval
  }
  get terminalShell(): string {
    return this.settings.terminalShell
  }

  publicSettings(): PublicSettings {
    const remote = this.settings.workspaceHost !== 'local'
    const base = remote
      ? this.settings.workspacePath.replace(/\/+$/, '').split('/').filter(Boolean).pop() || this.settings.workspacePath
      : this.workspacePath.split(/[\\/]/).filter(Boolean).pop() || this.workspacePath
    return {
      workspacePath: this.workspacePath,
      workspaceHost: this.settings.workspaceHost,
      workspaceName: remote ? `${base} @ ${this.settings.workspaceHost}` : base,
      goalsPath: remote ? posix.join(this.workspacePath, 'goals') : join(this.workspacePath, 'goals'),
      recentWorkspaces: this.settings.recentWorkspaces.map((item) => ({ ...item })),
      ompPath: this.settings.ompPath,
      chatModel: this.settings.chatModel,
      chatApproval: this.settings.chatApproval,
      implementerModel: this.settings.implementerModel,
      reviewerModel: this.settings.reviewerModel,
      loopApproval: this.settings.loopApproval,
      pinnedModels: [...this.settings.pinnedModels],
      terminalShell: this.settings.terminalShell,
      reduceMotion: this.settings.reduceMotion
    }
  }

  /** Switches the workspace; remote paths are not checked against the local disk. */
  setWorkspace(ref: WorkspaceRef): PublicSettings {
    const host = ref.host.trim() || 'local'
    const path = ref.path.trim()
    if (!path || (host === 'local' && (!existsSync(path) || !statSync(path).isDirectory()))) {
      throw new Error('Workspace folder does not exist.')
    }
    this.settings.workspaceHost = host
    this.settings.workspacePath = path
    this.settings.recentWorkspaces = [
      { host, path },
      ...this.settings.recentWorkspaces.filter((item) => item.host !== host || item.path !== path)
    ].slice(0, MAX_RECENT_WORKSPACES)
    this.persist()
    return this.publicSettings()
  }

  update(patch: SettingsPatch): PublicSettings {
    if (patch.workspacePath !== undefined) {
      const next = patch.workspacePath.trim()
      if (!next || !existsSync(next) || !statSync(next).isDirectory()) {
        throw new Error('Workspace folder does not exist.')
      }
      this.settings.workspacePath = next
      this.settings.workspaceHost = 'local'
    }
    if (patch.workspaceHost !== undefined && patch.workspaceHost.trim()) {
      this.settings.workspaceHost = patch.workspaceHost.trim()
    }
    if (patch.ompPath !== undefined) this.settings.ompPath = patch.ompPath.trim()
    if (patch.chatModel !== undefined) this.settings.chatModel = cleanModel(patch.chatModel)
    if (patch.chatApproval !== undefined) this.settings.chatApproval = approval(patch.chatApproval, this.settings.chatApproval)
    if (patch.implementerModel !== undefined) this.settings.implementerModel = cleanModel(patch.implementerModel)
    if (patch.reviewerModel !== undefined && cleanModel(patch.reviewerModel)) {
      this.settings.reviewerModel = cleanModel(patch.reviewerModel)
    }
    if (patch.loopApproval !== undefined) this.settings.loopApproval = approval(patch.loopApproval, this.settings.loopApproval)
    if (patch.pinnedModels !== undefined) {
      this.settings.pinnedModels = [...new Set(patch.pinnedModels.map(cleanModel).filter(Boolean))]
    }
    if (patch.terminalShell !== undefined && patch.terminalShell.trim()) {
      this.settings.terminalShell = patch.terminalShell.trim()
    }
    if (patch.reduceMotion !== undefined) this.settings.reduceMotion = patch.reduceMotion
    this.persist()
    return this.publicSettings()
  }
}
