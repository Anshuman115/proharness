import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  RefreshCw,
  RotateCcw,
  ShieldCheck
} from 'lucide-react'
import { useAppStore } from '../store'
import { parseDiff } from '../lib/diff'
import type { GitChangeStatus } from '@shared/types'

const STATUS_LABEL: Record<GitChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
  copied: 'C'
}

export function ChangesPanel(): React.JSX.Element {
  const git = useAppStore((state) => state.git)
  const diffPath = useAppStore((state) => state.diffPath)
  const diff = useAppStore((state) => state.diff)
  const diffLoading = useAppStore((state) => state.diffLoading)
  const loadDiff = useAppStore((state) => state.loadDiff)
  const restoreDiff = useAppStore((state) => state.restoreDiff)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!diffPath && git?.files.length) {
      void loadDiff(git.files[0].path)
    }
  }, [diffPath, git, loadDiff])

  useEffect(() => {
    setConfirmRestore(false)
    setCopied(false)
  }, [diffPath])

  const parsed = useMemo(() => (diff ? parseDiff(diff.diff) : null), [diff])
  const selected = git?.files.find((file) => file.path === diffPath) || null
  const totalAdd = git?.files.reduce((sum, file) => sum + file.additions, 0) || 0
  const totalDel = git?.files.reduce((sum, file) => sum + file.deletions, 0) || 0

  if (!git?.isRepo) {
    return (
      <div className="panel-empty">
        <GitBranch size={22} />
        <h3>No git repository</h3>
        <p>Pick a git-backed workspace to review changes here.</p>
      </div>
    )
  }

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <div className="changes-head__branch">
          <GitBranch size={13} />
          <strong>{git.branch || 'detached'}</strong>
          {git.ahead > 0 ? <span className="sync-chip">↑{git.ahead}</span> : null}
          {git.behind > 0 ? <span className="sync-chip">↓{git.behind}</span> : null}
        </div>
        <button type="button" className="icon-button" onClick={() => void refreshGit()} title="Refresh changes">
          <RefreshCw size={13} />
        </button>
      </div>

      {git.clean ? (
        <div className="panel-empty panel-empty--clean">
          <span className="clean-glyph">
            <ShieldCheck size={22} />
          </span>
          <h3>Working tree clean</h3>
          <p>Every file is committed. New agent edits will appear here as they land.</p>
          <div className="clean-meter">
            <span>0</span>
            <span>changed files</span>
          </div>
        </div>
      ) : (
        <>
          <div className="changes-summary">
            <span>
              <strong>{git.files.length}</strong> changed
            </span>
            <span className="diff-stat-add">+{totalAdd}</span>
            <span className="diff-stat-del">−{totalDel}</span>
          </div>

          <div className="file-list" role="listbox" aria-label="Changed files">
            {git.files.map((file) => (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={file.path === diffPath}
                className={`file-row ${file.path === diffPath ? 'is-active' : ''}`}
                onClick={() => void loadDiff(file.path)}
                title={file.path}
              >
                <span className={`file-status file-status--${file.status}`}>
                  {STATUS_LABEL[file.status]}
                </span>
                <span className="file-row__name">{file.path.split('/').pop()}</span>
                <span className="file-row__dir">
                  {file.path.includes('/') ? `${file.path.split('/').slice(0, -1).join('/')}/` : ''}
                </span>
                <span className="file-row__stats">
                  {file.additions ? <span className="diff-stat-add">+{file.additions}</span> : null}
                  {file.deletions ? <span className="diff-stat-del">−{file.deletions}</span> : null}
                </span>
                <ChevronRight size={12} />
              </button>
            ))}
          </div>

          <div className="diff-pane">
            {diffPath ? (
              <>
                <div className="diff-head">
                  <div className="diff-head__path" title={diffPath}>
                    <FileCode2 size={13} />
                    <span>{diffPath}</span>
                    {diff?.untracked ? <span className="mini-chip">new</span> : null}
                  </div>
                  <div className="diff-head__actions">
                    <button
                      type="button"
                      className="icon-button"
                      title="Copy diff"
                      onClick={() => {
                        if (!diff) return
                        void navigator.clipboard.writeText(diff.diff).then(() => {
                          setCopied(true)
                          window.setTimeout(() => setCopied(false), 1200)
                        })
                      }}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="Reveal in folder"
                      onClick={() => void window.proharness.git.reveal(diffPath)}
                    >
                      <ExternalLink size={13} />
                    </button>
                    {selected && !['untracked', 'added', 'renamed', 'copied'].includes(selected.status) ? (
                      <button
                        type="button"
                        className={`restore-button ${confirmRestore ? 'is-confirming' : ''}`}
                        title="Restore this file to HEAD"
                        onClick={() => {
                          if (!confirmRestore) {
                            setConfirmRestore(true)
                            return
                          }
                          void restoreDiff(diffPath)
                        }}
                      >
                        <RotateCcw size={12} />
                        {confirmRestore ? 'Confirm restore' : 'Restore'}
                      </button>
                    ) : null}
                  </div>
                </div>
                {copied ? <span className="copy-toast">copied</span> : null}
                <div className="diff-body">
                  {diffLoading ? <div className="panel-loading">Reading diff…</div> : null}
                  {!diffLoading && diff ? (
                    diff.binary ? (
                      <div className="panel-empty panel-empty--small">
                        <FileCode2 size={18} />
                        <p>{diff.diff}</p>
                      </div>
                    ) : (
                      <div className="diff-code" role="table" aria-label={`Diff for ${diffPath}`}>
                        {parsed?.lines.map((line, index) => (
                          <div key={`${index}-${line.kind}`} className={`diff-line diff-line--${line.kind}`}>
                            <span className="diff-no">{line.oldNo ?? ''}</span>
                            <span className="diff-no">{line.newNo ?? ''}</span>
                            <code>{line.text || ' '}</code>
                          </div>
                        ))}
                        {parsed?.truncated ? (
                          <div className="diff-truncated">Diff preview truncated. Open the file for the full change.</div>
                        ) : null}
                      </div>
                    )
                  ) : null}
                </div>
              </>
            ) : (
              <div className="panel-empty panel-empty--small">
                <FileCode2 size={18} />
                <p>Select a changed file to inspect its diff.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
