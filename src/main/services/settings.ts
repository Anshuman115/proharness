import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  DEFAULT_PROVIDER_BASE_URLS,
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type PermissionMode,
  type ProviderId,
  type ProviderPublic,
  type PublicSettings,
  type SettingsPatch
} from '@shared/types'

interface StoredProvider {
  baseUrl: string
  model: string
  apiKey?: string
}

interface StoredClaude {
  model: string
  permissionMode: PermissionMode
  apiKey?: string
  executablePath: string
}

interface StoredSettings {
  version: 1
  workspacePath: string
  claude: StoredClaude
  providers: Record<ProviderId, StoredProvider>
  terminalShell: string
  defaultReviewer: ProviderId
  defaultReviewerModel: string
  reduceMotion: boolean
}

const ENV_KEYS: Record<ProviderId, string[]> = {
  openai: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY']
}

const DEFAULT_CLAUDE_MODEL = process.env.PROHARNESS_CLAUDE_MODEL || 'claude-sonnet-4-5'

function maskSecret(value: string | undefined): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

function envSecret(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return undefined
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export class SettingsService {
  readonly filePath: string
  private settings: StoredSettings

  constructor() {
    this.filePath = join(app.getPath('userData'), 'settings.json')
    this.settings = this.load()
  }

  private defaultWorkspace(): string {
    const candidates = [
      process.env.PROHARNESS_WORKSPACE,
      app.isPackaged ? null : app.getAppPath(),
      join(app.getPath('documents'), 'ProHarness')
    ]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // Keep looking.
      }
    }
    return join(app.getPath('documents'), 'ProHarness')
  }

  private defaults(): StoredSettings {
    const providers = {} as Record<ProviderId, StoredProvider>
    for (const id of PROVIDER_IDS) {
      providers[id] = {
        baseUrl: process.env[`PROHARNESS_${id.toUpperCase()}_BASE_URL`] || DEFAULT_PROVIDER_BASE_URLS[id],
        model: process.env[`PROHARNESS_${id.toUpperCase()}_MODEL`] || DEFAULT_PROVIDER_MODELS[id]
      }
    }
    return {
      version: 1,
      workspacePath: this.defaultWorkspace(),
      claude: {
        model: DEFAULT_CLAUDE_MODEL,
        permissionMode: 'default',
        executablePath: process.env.PROHARNESS_CLAUDE_EXECUTABLE || ''
      },
      providers,
      terminalShell: process.env.SHELL || '/bin/bash',
      defaultReviewer: 'deepseek',
      defaultReviewerModel: DEFAULT_PROVIDER_MODELS.deepseek,
      reduceMotion: false
    }
  }

  private load(): StoredSettings {
    const defaults = this.defaults()
    const stored = readJson<Partial<StoredSettings>>(this.filePath)
    if (!stored) return defaults

    const providers = { ...defaults.providers }
    for (const id of PROVIDER_IDS) {
      const incoming = stored.providers?.[id]
      if (incoming) {
        providers[id] = {
          baseUrl: incoming.baseUrl || providers[id].baseUrl,
          model: incoming.model || providers[id].model,
          apiKey: incoming.apiKey
        }
      }
    }

    return {
      ...defaults,
      ...stored,
      version: 1,
      workspacePath: stored.workspacePath || defaults.workspacePath,
      claude: { ...defaults.claude, ...stored.claude },
      providers,
      defaultReviewer:
        stored.defaultReviewer && PROVIDER_IDS.includes(stored.defaultReviewer)
          ? stored.defaultReviewer
          : defaults.defaultReviewer,
      defaultReviewerModel: stored.defaultReviewerModel || defaults.defaultReviewerModel
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
      // Best effort on platforms without POSIX modes.
    }
  }

  private encrypt(secret: string): string {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return `safe:${safeStorage.encryptString(secret).toString('base64')}`
      }
    } catch {
      // Fall through to the portable representation.
    }
    return `b64:${Buffer.from(secret, 'utf8').toString('base64')}`
  }

  private decrypt(secret: string | undefined): string | undefined {
    if (!secret) return undefined
    if (secret.startsWith('safe:')) {
      try {
        return safeStorage.decryptString(Buffer.from(secret.slice(5), 'base64'))
      } catch {
        return undefined
      }
    }
    if (secret.startsWith('b64:')) {
      try {
        return Buffer.from(secret.slice(4), 'base64').toString('utf8')
      } catch {
        return undefined
      }
    }
    // Older / hand-edited settings may contain a raw value.
    return secret
  }

  get workspacePath(): string {
    return this.settings.workspacePath
  }

  get terminalShell(): string {
    return this.settings.terminalShell
  }

  get claudeModel(): string {
    return this.settings.claude.model
  }

  get permissionMode(): PermissionMode {
    return this.settings.claude.permissionMode
  }

  get claudeExecutablePath(): string {
    if (this.settings.claude.executablePath) return this.settings.claude.executablePath
    if (app.isPackaged && process.platform === 'linux') {
      const bundled = join(process.resourcesPath, 'claude')
      if (existsSync(bundled)) return bundled
    }
    return ''
  }

  get defaultReviewer(): ProviderId {
    return this.settings.defaultReviewer
  }

  get defaultReviewerModel(): string {
    return this.settings.defaultReviewerModel
  }

  get reduceMotion(): boolean {
    return this.settings.reduceMotion
  }

  getClaudeApiKey(): string | undefined {
    return this.decrypt(this.settings.claude.apiKey) || envSecret(['ANTHROPIC_API_KEY'])
  }

  getClaudeEnvKey(): boolean {
    return Boolean(envSecret(['ANTHROPIC_API_KEY']))
  }

  getProviderApiKey(provider: ProviderId): string | undefined {
    return this.decrypt(this.settings.providers[provider]?.apiKey) || envSecret(ENV_KEYS[provider])
  }

  getProviderEnvKey(provider: ProviderId): boolean {
    return Boolean(envSecret(ENV_KEYS[provider]))
  }

  getProviderBaseUrl(provider: ProviderId): string {
    return this.settings.providers[provider].baseUrl
  }

  getProviderModel(provider: ProviderId): string {
    return this.settings.providers[provider].model
  }

  providerIsConfigured(provider: ProviderId): boolean {
    return Boolean(this.getProviderApiKey(provider))
  }

  publicSettings(): PublicSettings {
    const providers: ProviderPublic[] = PROVIDER_IDS.map((id) => {
      const stored = this.settings.providers[id]
      const configuredKey = this.decrypt(stored.apiKey)
      const envKey = this.getProviderEnvKey(id)
      return {
        id,
        label: PROVIDER_LABELS[id],
        baseUrl: stored.baseUrl,
        model: stored.model,
        hasKey: Boolean(configuredKey || envKey),
        keyHint: configuredKey ? maskSecret(configuredKey) : envKey ? 'from environment' : '',
        envKey
      }
    })

    const claudeStoredKey = this.decrypt(this.settings.claude.apiKey)
    const claudeEnvKey = this.getClaudeEnvKey()

    return {
      workspacePath: this.workspacePath,
      workspaceName: this.workspacePath.split(/[\\/]/).filter(Boolean).pop() || this.workspacePath,
      goalsPath: join(this.workspacePath, 'goals'),
      claude: {
        model: this.settings.claude.model,
        permissionMode: this.settings.claude.permissionMode,
        hasApiKey: Boolean(claudeStoredKey || claudeEnvKey),
        apiKeyHint: claudeStoredKey
          ? maskSecret(claudeStoredKey)
          : claudeEnvKey
            ? 'from environment'
            : 'Claude Code login',
        envKey: claudeEnvKey,
        executablePath: this.settings.claude.executablePath,
        claudeCodeVersion: null
      },
      providers,
      terminalShell: this.settings.terminalShell,
      defaultReviewer: this.defaultReviewer,
      defaultReviewerModel: this.defaultReviewerModel,
      reduceMotion: this.reduceMotion
    }
  }

  update(patch: SettingsPatch): PublicSettings {
    if (patch.workspacePath !== undefined) {
      const next = patch.workspacePath.trim()
      if (!next || !existsSync(next)) {
        throw new Error('Workspace folder does not exist.')
      }
      this.settings.workspacePath = next
    }

    if (patch.claude) {
      if (patch.claude.model !== undefined && patch.claude.model.trim()) {
        this.settings.claude.model = patch.claude.model.trim()
      }
      if (patch.claude.permissionMode !== undefined) {
        this.settings.claude.permissionMode = patch.claude.permissionMode
      }
      if (patch.claude.executablePath !== undefined) {
        this.settings.claude.executablePath = patch.claude.executablePath.trim()
      }
      if (patch.claude.clearApiKey) {
        delete this.settings.claude.apiKey
      } else if (patch.claude.apiKey && patch.claude.apiKey.trim()) {
        this.settings.claude.apiKey = this.encrypt(patch.claude.apiKey.trim())
      }
    }

    if (patch.providers) {
      for (const id of PROVIDER_IDS) {
        const incoming = patch.providers[id]
        if (!incoming) continue
        const provider = this.settings.providers[id]
        if (incoming.baseUrl !== undefined && incoming.baseUrl.trim()) {
          provider.baseUrl = incoming.baseUrl.trim().replace(/\/+$/, '')
        }
        if (incoming.model !== undefined && incoming.model.trim()) {
          provider.model = incoming.model.trim()
        }
        if (incoming.clearApiKey) {
          delete provider.apiKey
        } else if (incoming.apiKey && incoming.apiKey.trim()) {
          provider.apiKey = this.encrypt(incoming.apiKey.trim())
        }
      }
    }

    if (patch.terminalShell !== undefined && patch.terminalShell.trim()) {
      this.settings.terminalShell = patch.terminalShell.trim()
    }
    if (patch.defaultReviewer && PROVIDER_IDS.includes(patch.defaultReviewer)) {
      this.settings.defaultReviewer = patch.defaultReviewer
    }
    if (patch.defaultReviewerModel !== undefined && patch.defaultReviewerModel.trim()) {
      this.settings.defaultReviewerModel = patch.defaultReviewerModel.trim()
    }
    if (patch.reduceMotion !== undefined) {
      this.settings.reduceMotion = patch.reduceMotion
    }

    this.persist()
    return this.publicSettings()
  }
}
