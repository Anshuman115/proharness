import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { useAppStore } from '../store'

/** Scaffolds a goal folder, optionally asking the active session to draft its design and plan. */
export function NewGoalDialog(): React.JSX.Element | null {
  const open = useAppStore((state) => state.newGoalOpen)
  const setOpen = useAppStore((state) => state.setNewGoalOpen)
  const createGoal = useAppStore((state) => state.createGoal)
  const sendMessage = useAppStore((state) => state.sendMessage)
  const activeTab = useAppStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId))
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTitle('')
      setBrief('')
      setError(null)
    }
  }, [open])

  if (!open) return null
  const canDraft = Boolean(brief.trim()) && activeTab?.status === 'idle'

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    setBusy(true)
    setError(null)
    try {
      await createGoal(title)
      const goal = useAppStore.getState().activeGoalId
      if (canDraft && goal) {
        await sendMessage(
          [
            `I created goals/${goal}/DESIGN.md and goals/${goal}/PLAN.md as stubs for a new goal: "${title.trim()}".`,
            '',
            'Brief:',
            brief.trim(),
            '',
            'Explore the repository as needed, then rewrite both files:',
            '- DESIGN.md: purpose, scope (in/out), approach, interfaces, risks. Keep the `status:` frontmatter.',
            '- PLAN.md: 2–5 phases as `## Phase N — Name`, each with small, independently verifiable tasks written as `- [ ] **N.M** Task`.',
            'Each task should be one reviewable commit. Do not implement anything yet, and do not commit goals/.'
          ].join('\n')
        )
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setOpen(false)}>
      <div className="small-dialog" role="dialog" aria-modal="true" aria-labelledby="new-goal-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="small-dialog__head">
          <h2 id="new-goal-title">New goal</h2>
          <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="field">
          <label htmlFor="goal-title">Title</label>
          <input
            id="goal-title"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !brief.trim()) void submit()
              if (event.key === 'Escape') setOpen(false)
            }}
            placeholder="Offline sync for the mobile app"
          />
        </div>
        <div className="field">
          <label htmlFor="goal-brief">Brief (optional)</label>
          <textarea
            id="goal-brief"
            rows={5}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="What it should do and any constraints. The current session will draft DESIGN.md and a phased PLAN.md from this."
          />
          <p className="field-hint">
            {brief.trim()
              ? activeTab?.status === 'idle'
                ? 'The active session will write the design and plan.'
                : 'The active session is busy; only the stub files will be created.'
              : 'Without a brief, ProHarness creates stub files you can edit.'}
          </p>
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="small-dialog__footer">
          <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--accent" onClick={() => void submit()} disabled={busy || !title.trim()}>
            {busy ? <Loader2 size={13} className="spin" /> : null}
            {canDraft ? 'Create and draft' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
