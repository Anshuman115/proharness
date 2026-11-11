import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_REVIEWER } from '@shared/defaults'
import { DEFAULT_PINNED, emptyPrefs, resolveModel } from '@shared/models'
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type HostModelPrefs,
  type ModelInfo,
  type PublicSettings,
  type SettingsPatch,
  type WorkspaceRef
} from '@shared/types'

interface StoredSettings {
  version: 3
  workspacePath: string
  workspaceHost: string
  recentWorkspaces: WorkspaceRef[]
  ompPath: string
  /** Model choices per host id. */
  models: Record<string, HostModelPrefs>
  shareLoginHosts: string[]
  chatApproval: ApprovalMode
  loopApproval: ApprovalMode
  pinnedModels: string[]
  terminalShell: string
  reduceMotion: boolean
}

const MAX_RECENT_WORKSPACES = 12


function cleanPrefs(value: unknown): HostModelPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    chatModel: cleanModel(raw.chatModel),
    implementerModel: cleanModel(raw.implementerModel),
    reviewerModel: cleanModel(raw.reviewerModel)
  }
}

/** The v2 default pins, before the Command Code equivalents were added. */
const V2_DEFAULT_PINS = [
  'anthropic/claude-opus-5-5',
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-haiku-5-5',
  'openai-codex/gpt-6.1-sol',
  'openai-codex/gpt-6.1-terra',
  'openai-codex/gpt-6-luna',
  'commandcode/deepseek/deepseek-v4.1-flash'
]

function migratePins(value: unknown, defaults: string[]): string[] {
  if (!Array.isArray(value)) return defaults
  const pins = value.map(cleanModel).filter(Boolean)
  // Untouched old defaults move to the new defaults; customised lists stay as they are.
  const untouched = pins.length === V2_DEFAULT_PINS.length && pins.every((pin, index) => pin === V2_DEFAULT_PINS[index])
  return untouched ? defaults : pins
}

type JsonRead<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'invalid' }

function readJson<T>(file: string): JsonRead<T> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  try {
    const value = JSON.parse(raw) as T
    if (!value || typeof value !== 'object') return { status: 'invalid' }
    return { status: 'ok', value }
  } catch {
    return { status: 'invalid' }
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
      version: 3,
      workspacePath: this.defaultWorkspace(),
      workspaceHost: 'local',
      recentWorkspaces: [],
      ompPath: process.env.PROHARNESS_OMP || '',
      models: { local: { ...emptyPrefs(), reviewerModel: DEFAULT_REVIEWER } },
      shareLoginHosts: [],
      chatApproval: 'write',
      loopApproval: 'yolo',
      pinnedModels: [...DEFAULT_PINNED],
      terminalShell: process.env.SHELL || '/bin/zsh',
      reduceMotion: false
    }
  }

  private load(): StoredSettings {
    const defaults = this.defaults()
    const read = readJson<Record<string, unknown>>(this.filePath)
    if (read.status === 'missing') return defaults
    if (read.status === 'invalid') {
      this.preserveCorrupt()
      return defaults
    }
    const stored = read.value
    const workspaceHost =
      typeof stored.workspaceHost === 'string' && stored.workspaceHost.trim()
        ? stored.workspaceHost.trim()
        : defaults.workspaceHost
    // A remote path is resolved on the server, so it need not exist locally.
    const workspace =
      typeof stored.workspacePath === 'string' &&
      (workspaceHost !== 'local' || existsSync(stored.workspacePath))
    return {
      version: 3,
      workspacePath: workspace ? (stored.workspacePath as string) : defaults.workspacePath,
      workspaceHost,
      recentWorkspaces: Array.isArray(stored.recentWorkspaces)
        ? (stored.recentWorkspaces as unknown[])
            .map((item) => cleanWorkspaceRef(item))
            .filter((item): item is WorkspaceRef => item !== null)
            .slice(0, MAX_RECENT_WORKSPACES)
        : defaults.recentWorkspaces,
      ompPath: typeof stored.ompPath === 'string' ? stored.ompPath : defaults.ompPath,
      models: this.loadModels(stored, defaults.models),
      shareLoginHosts: Array.isArray(stored.shareLoginHosts)
        ? [...new Set((stored.shareLoginHosts as unknown[]).map(cleanModel).filter((host) => host && host !== 'local'))]
        : [],
      chatApproval: approval(stored.chatApproval, defaults.chatApproval),
      loopApproval: approval(stored.loopApproval, defaults.loopApproval),
      pinnedModels: migratePins(stored.pinnedModels, defaults.pinnedModels),
      terminalShell: typeof stored.terminalShell === 'string' && stored.terminalShell ? stored.terminalShell : defaults.terminalShell,
      reduceMotion: Boolean(stored.reduceMotion)
    }
  }

  /** Keeps an unparseable settings file without replacing an earlier backup. */
  private preserveCorrupt(): void {
    let target = `${this.filePath}.corrupt`
    for (let n = 2; existsSync(target); n += 1) target = `${this.filePath}.corrupt-${n}`
    try {
      renameSync(this.filePath, target)
    } catch {
      // Best effort.
    }
  }

  /** Reads per-host prefs; settings from before v3 keep their flat fields as the local prefs. */
  private loadModels(stored: Record<string, unknown>, defaults: Record<string, HostModelPrefs>): Record<string, HostModelPrefs> {
    const models: Record<string, HostModelPrefs> = {}
    if (stored.models && typeof stored.models === 'object') {
      for (const [host, prefs] of Object.entries(stored.models as Record<string, unknown>)) {
        if (host.trim()) models[host] = cleanPrefs(prefs)
      }
    }
    if (!models.local) {
      const legacy = cleanPrefs(stored)
      models.local = {
        ...legacy,
        reviewerModel: legacy.reviewerModel || defaults.local.reviewerModel
      }
    }
    return models
  }

  /** Saved prefs for a host, without catalog checks. */
  prefsFor(host: string = this.settings.workspaceHost): HostModelPrefs {
    return { ...emptyPrefs(), ...(this.settings.models[host] || {}) }
  }

  /** Effective models on the active host; set by the omp catalog. */
  private resolved: (HostModelPrefs & { notes: string[] }) | null = null

  /** Checks the active host's saved models against its catalog and remembers the result. */
  resolveFor(models: ModelInfo[], hostDefault: string | null): HostModelPrefs & { notes: string[] } {
    const saved = this.prefsFor()
    const chat = resolveModel('chat', saved.chatModel, models, hostDefault)
    const implementer = resolveModel('implementer', saved.implementerModel, models, hostDefault)
    const reviewer = resolveModel('reviewer', saved.reviewerModel, models, hostDefault)
    this.resolved = {
      chatModel: chat.model,
      implementerModel: implementer.model,
      reviewerModel: reviewer.model,
      notes: [chat.note, implementer.note, reviewer.note].filter((note): note is string => Boolean(note))
    }
    return this.resolved
  }

  private effective(): HostModelPrefs & { notes: string[] } {
    return this.resolved || { ...this.prefsFor(), notes: [] }
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
    return this.effective().chatModel
  }
  get chatApproval(): ApprovalMode {
    return this.settings.chatApproval
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
      recentWorkspaces: this.settings.recentWorkspaces.map((item) => ({ ...item })),
      ompPath: this.settings.ompPath,
      chatModel: this.effective().chatModel,
      chatApproval: this.settings.chatApproval,
      implementerModel: this.effective().implementerModel,
      reviewerModel: this.effective().reviewerModel,
      modelNotes: [...this.effective().notes],
      loopApproval: this.settings.loopApproval,
      pinnedModels: [...this.settings.pinnedModels],
      terminalShell: this.settings.terminalShell,
      reduceMotion: this.settings.reduceMotion
    }
  }

  sharesLogins(host: string): boolean {
    return host !== 'local' && this.settings.shareLoginHosts.includes(host)
  }

  setShareLogins(host: string, enabled: boolean): PublicSettings {
    if (host === 'local') throw new Error('This Mac already uses its own logins.')
    const others = this.settings.shareLoginHosts.filter((item) => item !== host)
    this.settings.shareLoginHosts = enabled ? [...others, host] : others
    this.persist()
    return this.publicSettings()
  }

  /** Switches the workspace; remote paths are not checked against the local disk. */
  setWorkspace(ref: WorkspaceRef): PublicSettings {
    const host = ref.host.trim() || 'local'
    const path = ref.path.trim()
    if (!path || (host === 'local' && (!existsSync(path) || !statSync(path).isDirectory()))) {
      throw new Error('Workspace folder does not exist.')
    }
    if (host !== this.settings.workspaceHost) this.resolved = null
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
      if (this.settings.workspaceHost !== 'local') this.resolved = null
      this.settings.workspacePath = next
      this.settings.workspaceHost = 'local'
    }
    if (patch.workspaceHost !== undefined && patch.workspaceHost.trim() && patch.workspaceHost.trim() !== this.settings.workspaceHost) {
      this.settings.workspaceHost = patch.workspaceHost.trim()
      this.resolved = null
    }
    if (patch.ompPath !== undefined) this.settings.ompPath = patch.ompPath.trim()
    // Model choices belong to the active host.
    const host = this.settings.workspaceHost
    const prefs = this.prefsFor(host)
    let modelsChanged = false
    if (patch.chatModel !== undefined) {
      prefs.chatModel = cleanModel(patch.chatModel)
      modelsChanged = true
    }
    if (patch.implementerModel !== undefined) {
      prefs.implementerModel = cleanModel(patch.implementerModel)
      modelsChanged = true
    }
    if (patch.reviewerModel !== undefined && cleanModel(patch.reviewerModel)) {
      prefs.reviewerModel = cleanModel(patch.reviewerModel)
      modelsChanged = true
    }
    if (modelsChanged) {
      this.settings.models = { ...this.settings.models, [host]: prefs }
      // A choice the user just made is valid by definition; drop stale notes.
      if (this.resolved) this.resolved = { ...prefs, notes: [] }
    }
    if (patch.chatApproval !== undefined) this.settings.chatApproval = approval(patch.chatApproval, this.settings.chatApproval)
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
