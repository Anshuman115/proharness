import { useEffect, useState } from 'react'
import { ExternalLink, FileText, X } from 'lucide-react'
import type { GoalDetail } from '@shared/types'
import { useAppStore } from '../store'
import { Markdown } from './Markdown'

function stripFrontmatter(value: string): string {
  return value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

export function GoalDesignDialog(): React.JSX.Element | null {
  const goalId = useAppStore((state) => state.designGoalId)
  const goals = useAppStore((state) => state.goals)
  const activeDetail = useAppStore((state) => state.goalDetail)
  const setDesignGoal = useAppStore((state) => state.setDesignGoal)
  const [detail, setDetail] = useState<GoalDetail | null>(null)
  const [view, setView] = useState<'design' | 'plan'>('design')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!goalId) return
    setError(null)
    if (activeDetail?.id === goalId) {
      setDetail(activeDetail)
      return
    }
    void window.proharness.goals
      .read(goalId)
      .then(setDetail)
      .catch((err: Error) => setError(err.message))
  }, [goalId, activeDetail])

  useEffect(() => {
    if (!goalId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDesignGoal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goalId, setDesignGoal])

  if (!goalId) return null
  const summary = goals.find((goal) => goal.id === goalId)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => setDesignGoal(null)}>
      <div
        className="goal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="goal-dialog__head">
          <div>
            <p className="eyebrow">
              <FileText size={11} /> Goal dossier
            </p>
            <h2 id="goal-dialog-title">{summary?.title || detail?.title || goalId}</h2>
            <p className="mono goal-dialog__path">goals/{goalId}/</p>
          </div>
          <div className="goal-dialog__actions">
            <div className="segmented segmented--small">
              <button
                type="button"
                className={view === 'design' ? 'is-active' : ''}
                onClick={() => setView('design')}
              >
                DESIGN.md
              </button>
              <button
                type="button"
                className={view === 'plan' ? 'is-active' : ''}
                onClick={() => setView('plan')}
              >
                PLAN.md
              </button>
            </div>
            <button
              type="button"
              className="icon-button"
              title="Open in editor"
              onClick={() => {
                const path = view === 'design' ? detail?.designPath : detail?.planPath
                if (path) void window.proharness.shell.openPath(path)
              }}
            >
              <ExternalLink size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setDesignGoal(null)}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="goal-dialog__body">
          {error ? <div className="inline-error">{error}</div> : null}
          {detail ? (
            <Markdown>{stripFrontmatter(view === 'design' ? detail.design : detail.plan)}</Markdown>
          ) : (
            <p className="muted">Loading dossier…</p>
          )}
        </div>
      </div>
    </div>
  )
}
