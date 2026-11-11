import { useEffect, useMemo, useState } from 'react'
import { Folder, FolderOpen, Loader2, Server, X } from 'lucide-react'
import type { WorkspaceListing, WorkspaceRef } from '@shared/types'
import { useAppStore } from '../store'

const LOCAL = 'local'

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

function defaultPath(host: string): string {
  if (host !== LOCAL) return '~'
  return useAppStore.getState().settings?.workspacePath || '~'
}

/** Opens a folder on this Mac or an ssh host; browses directories before switching. */
export function WorkspaceDialog(): React.JSX.Element | null {
  const open = useAppStore((state) => state.workspaceOpen)
  const settings = useAppStore((state) => state.settings)
  const setOpen = useAppStore((state) => state.setWorkspaceOpen)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const chooseWorkspace = useAppStore((state) => state.chooseWorkspace)

  const [hosts, setHosts] = useState<string[]>([])
  const [host, setHost] = useState(LOCAL)
  const [otherHost, setOtherHost] = useState('')
  const [input, setInput] = useState('')
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped on every explicit navigation so re-picking the same host or path reloads.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    const current = useAppStore.getState().settings
    const nextHost = current?.workspaceHost || LOCAL
    setHost(nextHost)
    setOtherHost('')
    setInput(defaultPath(nextHost))
    setDir(defaultPath(nextHost))
    setListing(null)
    setError(null)
    setBusy(false)
    setHosts([])
    void window.proharness.workspace
      .sshHosts()
      .then((list) => setHosts(list))
      .catch(() => setHosts([]))
  }, [open])

  useEffect(() => {
    if (!open || !dir) return
    let live = true
    setLoading(true)
    setError(null)
    window.proharness.workspace
      .listDir(host, dir)
      .then((result) => {
        if (!live) return
        setListing(result)
        setInput(result.path)
      })
      .catch((err: Error) => {
        if (!live) return
        setListing(null)
        setError(err.message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [open, host, dir, reload])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, setOpen])

  const options = useMemo(() => {
    const list = [LOCAL, ...hosts]
    if (host !== LOCAL && !list.includes(host)) list.push(host)
    return list
  }, [hosts, host])

  const recent = settings?.recentWorkspaces || []

  if (!open) return null

  const pickHost = (next: string): void => {
    setHost(next)
    const start = defaultPath(next)
    setInput(start)
    setDir(start)
    setListing(null)
    setError(null)
    setReload((value) => value + 1)
  }

  const useOtherHost = (): void => {
    const next = otherHost.trim()
    if (!next || next === LOCAL) return
    pickHost(next)
  }

  const navigate = (path: string): void => {
    setInput(path)
    setDir(path)
    setReload((value) => value + 1)
  }

  const submitPath = (): void => {
    const next = input.trim() || '~'
    setInput(next)
    setDir(next)
    setReload((value) => value + 1)
  }

  const openRef = async (ref: WorkspaceRef): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await openWorkspace(ref)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const openCurrent = (): void => {
    const path = listing?.path || input.trim()
    if (!path) return
    void openRef({ host, path })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setOpen(false)}>
      <div
        className="workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="workspace-dialog__head">
          <div>
            <p className="eyebrow">
              <Server size={11} /> Workspace
            </p>
            <h2 id="workspace-dialog-title">Open workspace</h2>
          </div>
          <button type="button" className="icon-button" onClick={() => setOpen(false)} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="workspace-dialog__host">
          <div className="segmented workspace-dialog__hosts" role="group" aria-label="Workspace host">
            {options.map((value) => (
              <button key={value} type="button" className={host === value ? 'is-active' : ''} onClick={() => pickHost(value)}>
                {value === LOCAL ? 'This Mac' : value}
              </button>
            ))}
          </div>
          <div className="field workspace-dialog__other">
            <label htmlFor="workspace-other-host">Other host</label>
            <input
              id="workspace-other-host"
              value={otherHost}
              onChange={(event) => setOtherHost(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') useOtherHost()
              }}
              placeholder="user@host"
              spellCheck={false}
            />
          </div>
        </div>

        {recent.length ? (
          <div className="workspace-dialog__section">
            <p className="eyebrow">Recent</p>
            <div className="workspace-dialog__recent">
              {recent.map((item) => (
                <button
                  key={`${item.host}:${item.path}`}
                  type="button"
                  className="recent-row workspace-recent"
                  onClick={() => void openRef(item)}
                  disabled={busy}
                >
                  <span className="recent-row__title">{item.path}</span>
                  <span className="recent-row__meta">
                    <span className="host-chip">{item.host === LOCAL ? 'This Mac' : item.host}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="workspace-dialog__section workspace-dialog__browser">
          <div className="field">
            <label htmlFor="workspace-path">Folder</label>
            <input
              id="workspace-path"
              autoFocus
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitPath()
              }}
              placeholder={host === LOCAL ? '/Users/you/project' : '~/project'}
              spellCheck={false}
            />
          </div>

          {loading ? (
            <p className="workspace-dialog__status">
              <Loader2 size={13} className="spin" />
              {host === LOCAL ? 'Listing folders…' : `Connecting to ${host}…`}
            </p>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}

          <div className="workspace-dialog__list">
            {listing ? (
              <>
                {listing.path !== '/' ? (
                  <div className="dir-row">
                    <button type="button" className="dir-row__main" onClick={() => navigate(parentPath(listing.path))}>
                      <Folder size={13} className="dir-row__icon" />
                      <span className="dir-row__name">..</span>
                    </button>
                  </div>
                ) : null}
                {listing.entries.map((entry) => (
                  <div className="dir-row" key={entry.name}>
                    <button
                      type="button"
                      className="dir-row__main"
                      onClick={() => navigate(joinPath(listing.path, entry.name))}
                      onDoubleClick={() => {
                        if (entry.isRepo) void openRef({ host, path: joinPath(listing.path, entry.name) })
                      }}
                    >
                      <Folder size={13} className="dir-row__icon" />
                      <span className="dir-row__name">{entry.name}</span>
                      {entry.isRepo ? <span className="mini-chip">git</span> : null}
                    </button>
                    {entry.isRepo ? (
                      <button
                        type="button"
                        className="btn btn--quiet btn--sm dir-row__open"
                        onClick={() => void openRef({ host, path: joinPath(listing.path, entry.name) })}
                      >
                        Open
                      </button>
                    ) : null}
                  </div>
                ))}
                {!listing.entries.length && !loading ? <p className="muted small workspace-dialog__empty">No folders here.</p> : null}
              </>
            ) : null}
          </div>
        </div>

        <div className="workspace-dialog__foot">
          {host === LOCAL ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                void chooseWorkspace()
                setOpen(false)
              }}
            >
              <FolderOpen size={13} /> Choose with Finder…
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn btn--accent" onClick={openCurrent} disabled={busy || loading || !listing}>
            {busy ? <Loader2 size={13} className="spin" /> : null}
            Open this folder
          </button>
        </div>
      </div>
    </div>
  )
}
