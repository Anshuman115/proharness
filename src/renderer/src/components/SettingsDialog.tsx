import { useEffect, useState } from 'react'
import {
  Check,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  ShieldCheck,
  Terminal,
  X
} from 'lucide-react'
import type { PermissionMode, ProviderId, ProviderTestResult, SettingsPatch } from '@shared/types'
import { PROVIDER_IDS } from '@shared/types'
import { useAppStore } from '../store'

interface ProviderDraft {
  baseUrl: string
  model: string
  apiKey: string
  clear: boolean
}

const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions'
]

export function SettingsDialog(): React.JSX.Element | null {
  const open = useAppStore((state) => state.settingsOpen)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const chooseWorkspace = useAppStore((state) => state.chooseWorkspace)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const pushToast = useAppStore((state) => state.pushToast)
  const appVersion = useAppStore((state) => state.appVersion)

  const [workspace, setWorkspace] = useState('')
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [executablePath, setExecutablePath] = useState('')
  const [claudeKey, setClaudeKey] = useState('')
  const [clearClaude, setClearClaude] = useState(false)
  const [showClaudeKey, setShowClaudeKey] = useState(false)
  const [providers, setProviders] = useState<Record<ProviderId, ProviderDraft>>({
    openai: { baseUrl: '', model: '', apiKey: '', clear: false },
    deepseek: { baseUrl: '', model: '', apiKey: '', clear: false },
    kimi: { baseUrl: '', model: '', apiKey: '', clear: false }
  })
  const [terminalShell, setTerminalShell] = useState('')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [defaultReviewer, setDefaultReviewer] = useState<ProviderId>('deepseek')
  const [defaultReviewerModel, setDefaultReviewerModel] = useState('')
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [testResults, setTestResults] = useState<Partial<Record<ProviderId, ProviderTestResult>>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !settings) return
    setWorkspace(settings.workspacePath)
    setModel(settings.claude.model)
    setPermissionMode(settings.claude.permissionMode)
    setExecutablePath(settings.claude.executablePath)
    setClaudeKey('')
    setClearClaude(false)
    const next = {} as Record<ProviderId, ProviderDraft>
    for (const id of PROVIDER_IDS) {
      const publicProvider = settings.providers.find((item) => item.id === id)
      next[id] = {
        baseUrl: publicProvider?.baseUrl || '',
        model: publicProvider?.model || '',
        apiKey: '',
        clear: false
      }
    }
    setProviders(next)
    setTerminalShell(settings.terminalShell)
    setReduceMotion(settings.reduceMotion)
    setDefaultReviewer(settings.defaultReviewer)
    setDefaultReviewerModel(settings.defaultReviewerModel)
    setError(null)
  }, [open, settings])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, saving, setSettingsOpen])

  if (!open || !settings) return null

  const patchProvider = (id: ProviderId, patch: Partial<ProviderDraft>): void => {
    setProviders((current) => ({ ...current, [id]: { ...current[id], ...patch } }))
    setTestResults((current) => ({ ...current, [id]: undefined }))
  }

  const testProvider = async (id: ProviderId): Promise<void> => {
    setTesting(id)
    try {
      const draft = providers[id]
      const result = await window.proharness.providers.test(id, {
        baseUrl: draft.baseUrl,
        model: draft.model,
        apiKey: draft.clear ? undefined : draft.apiKey
      })
      setTestResults((current) => ({ ...current, [id]: result }))
    } catch (err) {
      pushToast('error', (err as Error).message)
    } finally {
      setTesting(null)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const providerPatch: SettingsPatch['providers'] = {}
    for (const id of PROVIDER_IDS) {
      providerPatch[id] = {
        baseUrl: providers[id].baseUrl,
        model: providers[id].model,
        ...(providers[id].apiKey.trim() ? { apiKey: providers[id].apiKey.trim() } : {}),
        ...(providers[id].clear ? { clearApiKey: true } : {})
      }
    }
    const patch: SettingsPatch = {
      workspacePath: workspace,
      claude: {
        model,
        permissionMode,
        executablePath,
        ...(claudeKey.trim() ? { apiKey: claudeKey.trim() } : {}),
        ...(clearClaude ? { clearApiKey: true } : {})
      },
      providers: providerPatch,
      terminalShell,
      defaultReviewer,
      defaultReviewerModel,
      reduceMotion
    }
    try {
      await updateSettings(patch)
      setSettingsOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !saving && setSettingsOpen(false)}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="settings-dialog__head">
          <div>
            <p className="eyebrow">Harness configuration</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <div className="settings-dialog__head-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => !saving && setSettingsOpen(false)}
              aria-label="Close settings"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="settings-dialog__body">
          <section className="settings-section">
            <div className="settings-section__intro">
              <h3>Workspace</h3>
              <p>The project folder Claude reads, the terminal starts in, and goals/ resolves against.</p>
            </div>
            <div className="settings-section__fields">
              <div className="field">
                <label htmlFor="settings-workspace">Project folder</label>
                <div className="input-with-action">
                  <input
                    id="settings-workspace"
                    value={workspace}
                    onChange={(event) => setWorkspace(event.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => void chooseWorkspace()}
                  >
                    <FolderOpen size={13} /> Browse
                  </button>
                </div>
                <p className="field-hint">
                  Changing this workspace closes current sessions. Goals live in{' '}
                  <code>{workspace}/goals</code>.
                </p>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__intro">
              <h3>Claude runtime</h3>
              <p>The Agent SDK uses the Claude Code login on this machine, or an Anthropic API key.</p>
            </div>
            <div className="settings-section__fields">
              <div className="field-row">
                <div className="field field--grow">
                  <label htmlFor="settings-model">Model</label>
                  <input
                    id="settings-model"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="claude-sonnet-4-5"
                  />
                </div>
                <div className="field">
                  <label htmlFor="settings-mode">Default permission mode</label>
                  <select
                    id="settings-mode"
                    value={permissionMode}
                    onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
                  >
                    {PERMISSION_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="settings-claude-key">Anthropic API key</label>
                <div className="input-with-action">
                  <input
                    id="settings-claude-key"
                    type={showClaudeKey ? 'text' : 'password'}
                    value={claudeKey}
                    onChange={(event) => setClaudeKey(event.target.value)}
                    placeholder={settings.claude.hasApiKey ? settings.claude.apiKeyHint : 'uses Claude Code login'}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setShowClaudeKey((value) => !value)}
                    aria-label={showClaudeKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showClaudeKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {settings.claude.hasApiKey && !settings.claude.envKey ? (
                    <button
                      type="button"
                      className={`btn btn--sm ${clearClaude ? 'btn--danger' : 'btn--quiet'}`}
                      onClick={() => setClearClaude((value) => !value)}
                    >
                      {clearClaude ? 'Will clear' : 'Clear key'}
                    </button>
                  ) : null}
                </div>
                <p className="field-hint">
                  {settings.claude.envKey
                    ? 'ANTHROPIC_API_KEY is set in the environment. Stored values are not shown.'
                    : 'Keys are encrypted with the OS keychain when available. Leave empty to keep the current value.'}
                </p>
              </div>

              <div className="field">
                <label htmlFor="settings-executable">Claude Code executable (optional)</label>
                <div className="input-with-action">
                  <input
                    id="settings-executable"
                    value={executablePath}
                    onChange={(event) => setExecutablePath(event.target.value)}
                    placeholder="bundled Agent SDK executable"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => {
                      void window.proharness.settings.chooseClaudeExecutable().then((path) => {
                        if (path) setExecutablePath(path)
                      })
                    }}
                  >
                    <FolderOpen size={13} /> Choose
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__intro">
              <h3>Delegation models</h3>
              <p>
                OpenAI-compatible endpoints used for independent review, task-loop gates, and manual
                delegation. The loop will not commit without one.
              </p>
            </div>
            <div className="settings-section__fields">
              {PROVIDER_IDS.map((id) => {
                const info = settings.providers.find((item) => item.id === id)
                const draft = providers[id]
                const result = testResults[id]
                return (
                  <div className="provider-card" key={id}>
                    <div className="provider-card__head">
                      <span className={`provider-dot provider-dot--${id}`} />
                      <strong>{info?.label || id}</strong>
                      <span className={`key-state ${info?.hasKey ? 'is-ok' : 'is-missing'}`}>
                        <KeyRound size={10} />
                        {info?.hasKey ? info.keyHint || 'configured' : 'no key'}
                      </span>
                      <span className="provider-card__spacer" />
                      <button
                        type="button"
                        className="btn btn--quiet btn--sm"
                        onClick={() => void testProvider(id)}
                        disabled={testing === id}
                      >
                        {testing === id ? <Loader2 size={12} className="spin" /> : <ShieldCheck size={12} />}
                        Test
                      </button>
                    </div>
                    <div className="provider-card__grid">
                      <div className="field">
                        <label>Base URL</label>
                        <input
                          value={draft.baseUrl}
                          onChange={(event) => patchProvider(id, { baseUrl: event.target.value })}
                          spellCheck={false}
                        />
                      </div>
                      <div className="field">
                        <label>Model</label>
                        <input
                          value={draft.model}
                          onChange={(event) => patchProvider(id, { model: event.target.value })}
                          spellCheck={false}
                        />
                      </div>
                      <div className="field">
                        <label>API key</label>
                        <input
                          type="password"
                          value={draft.apiKey}
                          onChange={(event) => patchProvider(id, { apiKey: event.target.value })}
                          placeholder={info?.hasKey ? info.keyHint : 'not configured'}
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    {draft.clear || result || (info?.hasKey && !info.envKey) ? (
                      <div className="provider-card__footer">
                        {info?.hasKey && !info.envKey ? (
                          <button
                            type="button"
                            className={`text-link ${draft.clear ? 'text-link--danger' : ''}`}
                            onClick={() => patchProvider(id, { clear: !draft.clear, apiKey: '' })}
                          >
                            {draft.clear ? 'Key will be cleared on save — undo' : 'Clear saved key'}
                          </button>
                        ) : null}
                        {result ? (
                          <span className={`test-result ${result.ok ? 'is-ok' : 'is-bad'}`}>
                            {result.ok ? <Check size={11} /> : <X size={11} />}
                            {result.ok ? `${result.latencyMs}ms · ${result.message}` : result.message}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__intro">
              <h3>Loop & shell defaults</h3>
              <p>The default reviewer is preselected in the autonomous task loop and delegation panel.</p>
            </div>
            <div className="settings-section__fields">
              <div className="field-row">
                <div className="field">
                  <label htmlFor="settings-reviewer">Default reviewer</label>
                  <select
                    id="settings-reviewer"
                    value={defaultReviewer}
                    onChange={(event) => {
                      const id = event.target.value as ProviderId
                      setDefaultReviewer(id)
                      const info = settings.providers.find((item) => item.id === id)
                      setDefaultReviewerModel(providers[id].model || info?.model || '')
                    }}
                  >
                    {PROVIDER_IDS.map((id) => (
                      <option key={id} value={id}>
                        {settings.providers.find((item) => item.id === id)?.label || id}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field field--grow">
                  <label htmlFor="settings-reviewer-model">Default reviewer model</label>
                  <input
                    id="settings-reviewer-model"
                    value={defaultReviewerModel}
                    onChange={(event) => setDefaultReviewerModel(event.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="settings-shell">Terminal shell</label>
                <div className="input-with-action">
                  <input
                    id="settings-shell"
                    value={terminalShell}
                    onChange={(event) => setTerminalShell(event.target.value)}
                    spellCheck={false}
                    placeholder="/bin/bash"
                  />
                  <Terminal size={15} className="input-icon" />
                </div>
              </div>
              <div className="field">
                <label>Reduce motion</label>
                <button
                  type="button"
                  className={`switch ${reduceMotion ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={reduceMotion}
                  onClick={() => setReduceMotion((value) => !value)}
                >
                  <span />
                  {reduceMotion ? 'on' : 'off'}
                </button>
              </div>
              <div className="settings-runtime">
                <span>App v{appVersion}</span>
                <span>Linux Electron target</span>
              </div>
            </div>
          </section>
        </div>

        <div className="settings-dialog__footer">
          {error ? <div className="inline-error">{error}</div> : <span className="muted small">Changes apply to new turns.</span>}
          <div>
            <button type="button" className="btn btn--ghost" onClick={() => setSettingsOpen(false)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn--accent" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 size={13} className="spin" /> : <Check size={14} />}
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
