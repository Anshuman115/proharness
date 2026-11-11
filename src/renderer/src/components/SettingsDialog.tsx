import { useEffect, useState } from 'react'
import { Check, CheckCircle2, FolderOpen, Loader2, Pin, RefreshCw, X, XCircle } from 'lucide-react'
import { APPROVAL_MODES, type ApprovalMode, type SettingsPatch } from '@shared/types'
import { useAppStore } from '../store'
import { approvalHint, approvalLabel, formatRelative, shortModel } from '../lib/format'
import { ModelPicker } from './ModelPicker'

export function SettingsDialog(): React.JSX.Element | null {
  const open = useAppStore((state) => state.settingsOpen)
  const settings = useAppStore((state) => state.settings)
  const omp = useAppStore((state) => state.omp)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const setWorkspaceOpen = useAppStore((state) => state.setWorkspaceOpen)
  const refreshOmp = useAppStore((state) => state.refreshOmp)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const appVersion = useAppStore((state) => state.appVersion)

  const [ompPath, setOmpPath] = useState('')
  const [chatModel, setChatModel] = useState('')
  const [chatApproval, setChatApproval] = useState<ApprovalMode>('write')
  const [implementerModel, setImplementerModel] = useState('')
  const [reviewerModel, setReviewerModel] = useState('')
  const [pinned, setPinned] = useState<string[]>([])
  const [pinDraft, setPinDraft] = useState('')
  const [terminalShell, setTerminalShell] = useState('')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !settings) return
    setOmpPath(settings.ompPath)
    setChatModel(settings.chatModel)
    setChatApproval(settings.chatApproval)
    setImplementerModel(settings.implementerModel)
    setReviewerModel(settings.reviewerModel)
    setPinned(settings.pinnedModels)
    setTerminalShell(settings.terminalShell)
    setReduceMotion(settings.reduceMotion)
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

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const patch: SettingsPatch = {
      ompPath,
      chatModel,
      chatApproval,
      implementerModel,
      reviewerModel,
      pinnedModels: pinned,
      terminalShell,
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

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await refreshOmp()
    setRefreshing(false)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !saving && setSettingsOpen(false)}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-dialog__head">
          <div>
            <p className="eyebrow">ProHarness {appVersion}</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="icon-button" onClick={() => !saving && setSettingsOpen(false)} aria-label="Close settings">
            <X size={17} />
          </button>
        </div>

        <div className="settings-dialog__body">
          <section className="settings-section">
            <div className="settings-section__intro">
              <h3>Oh My Pi</h3>
              <p>ProHarness drives omp over its RPC mode. Providers, logins, skills and extensions come from your omp setup.</p>
            </div>
            <div className="settings-section__fields">
              <div className={`omp-status ${omp?.ok ? 'is-ok' : 'is-bad'}`}>
                {omp?.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                <div>
                  <strong>{omp?.ok ? `omp ${omp.version || ''}` : 'omp not ready'}</strong>
                  <span>
                    {omp?.ok
                      ? `${omp.models.length} models · default ${shortModel(omp.defaultModel)} · checked ${formatRelative(omp.checkedAt)}`
                      : omp?.error || 'Checking…'}
                  </span>
                  {omp?.path ? <code>{omp.path}</code> : null}
                </div>
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => void refresh()} disabled={refreshing}>
                  {refreshing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Recheck
                </button>
              </div>
              <div className="field">
                <label htmlFor="settings-omp">omp executable</label>
                <div className="input-with-action">
                  <input
                    id="settings-omp"
                    value={ompPath}
                    onChange={(event) => setOmpPath(event.target.value)}
                    placeholder="found on your login-shell PATH"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => void window.proharness.settings.chooseOmp().then((path) => path && setOmpPath(path))}
                  >
                    <FolderOpen size={13} /> Choose
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__intro">
              <h3>Models</h3>
              <p>Leave a model empty to use omp's configured default. Each tab can switch models at any time.</p>
            </div>
            <div className="settings-section__fields">
              <div className="field-row">
                <div className="field field--grow">
                  <label>New chat tabs</label>
                  <ModelPicker value={chatModel} onChange={setChatModel} emptyLabel="omp default" />
                </div>
                <div className="field">
                  <label htmlFor="settings-chat-approval">Chat approvals</label>
                  <select id="settings-chat-approval" value={chatApproval} onChange={(event) => setChatApproval(event.target.value as ApprovalMode)}>
                    {APPROVAL_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {approvalLabel(mode)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="field-hint">{approvalHint(chatApproval)}. Applies to tabs opened after saving.</p>
              <div className="field-row">
                <div className="field field--grow">
                  <label>Loop implementer</label>
                  <ModelPicker value={implementerModel} onChange={setImplementerModel} emptyLabel="omp default" />
                </div>
                <div className="field field--grow">
                  <label>Reviewer / second opinion</label>
                  <ModelPicker value={reviewerModel} onChange={setReviewerModel} align="right" />
                </div>
              </div>
              <div className="field">
                <label>Pinned models</label>
                <div className="pin-list">
                  {pinned.map((key) => (
                    <span key={key} className="pin-chip">
                      <Pin size={10} />
                      <span>{key}</span>
                      <button type="button" aria-label={`Unpin ${key}`} onClick={() => setPinned((list) => list.filter((item) => item !== key))}>
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  <ModelPicker
                    value={pinDraft}
                    compact
                    ariaLabel="Pin a model"
                    onChange={(key) => {
                      if (key && !pinned.includes(key)) setPinned((list) => [...list, key])
                      setPinDraft('')
                    }}
                  />
                </div>
                <p className="field-hint">Pinned models show first in every picker.</p>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__intro">
              <h3>Workspace</h3>
              <p>The folder omp works in. Plans live in goals/, which ProHarness adds to .git/info/exclude.</p>
            </div>
            <div className="settings-section__fields">
              <div className="field">
                <label>Project folder</label>
                <div className="input-with-action">
                  <input
                    value={settings.workspaceHost === 'local' ? settings.workspacePath : `${settings.workspaceHost}:${settings.workspacePath}`}
                    readOnly
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => {
                      setSettingsOpen(false)
                      setWorkspaceOpen(true)
                    }}
                  >
                    <FolderOpen size={13} /> Change
                  </button>
                </div>
                <p className="field-hint">Changing it closes open tabs and stops the loop.</p>
              </div>
              <div className="field-row">
                <div className="field field--grow">
                  <label htmlFor="settings-shell">Terminal shell</label>
                  <input id="settings-shell" value={terminalShell} onChange={(event) => setTerminalShell(event.target.value)} spellCheck={false} />
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
              </div>
            </div>
          </section>
        </div>

        <div className="settings-dialog__footer">
          {error ? <div className="inline-error">{error}</div> : <span className="muted small">Model and approval defaults apply to new tabs.</span>}
          <div>
            <button type="button" className="btn btn--ghost" onClick={() => setSettingsOpen(false)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn--accent" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 size={13} className="spin" /> : <Check size={14} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
