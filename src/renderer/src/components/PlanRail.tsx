import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, EyeOff, FileText, Play, Plus, Sparkles } from 'lucide-react'
import { useAppStore } from '../store'
import { stepLabel } from '../lib/format'


export function PlanRail(): React.JSX.Element {
  const leftOpen = useAppStore((state) => state.leftOpen)
  const goals = useAppStore((state) => state.goals)
  const activeGoalId = useAppStore((state) => state.activeGoalId)
  const detail = useAppStore((state) => state.goalDetail)
  const goalLoading = useAppStore((state) => state.goalLoading)
  const loop = useAppStore((state) => state.loop)
  const selectGoal = useAppStore((state) => state.selectGoal)
  const toggleTask = useAppStore((state) => state.toggleTask)
  const setDesignGoal = useAppStore((state) => state.setDesignGoal)
  const setWorkbenchTab = useAppStore((state) => state.setWorkbenchTab)
  const setNewGoalOpen = useAppStore((state) => state.setNewGoalOpen)
  const setDraft = useAppStore((state) => state.setDraft)
  const focusComposer = useAppStore((state) => state.focusComposer)
  const [collapsedPhases, setCollapsedPhases] = useState<Record<string, boolean>>({})

  const useNextTask = (): void => {
    if (!detail) return
    const next = detail.phases.flatMap((phase) => phase.tasks).find((task) => !task.checked)
    const text = next
      ? `Implement task ${next.id} of goal ${detail.id}: ${next.title}. Read goals/${detail.id}/DESIGN.md first, then make the change and verify it.`
      : `Review goals/${detail.id}/PLAN.md and tell me what remains before this goal can be considered complete.`
    setDraft(text)
    focusComposer()
  }

  return (
    <aside className={`rail ${leftOpen ? '' : 'is-collapsed'}`} aria-label="Project plan">
      <div className="rail__head">
        <div>
          <p className="eyebrow">
            <EyeOff size={10} /> local, not in git
          </p>
          <h2>Goals</h2>
        </div>
        <button type="button" className="icon-button" onClick={() => setNewGoalOpen(true)} title="New goal">
          <Plus size={15} />
        </button>
      </div>

      <div className="goal-list">
        {goals.length === 0 ? (
          <div className="rail-empty">
            <p>No goals yet.</p>
            <p className="muted">
              A goal is <code>goals/&lt;name&gt;/DESIGN.md</code> plus a phased <code>PLAN.md</code> checklist. The folder
              stays out of git.
            </p>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setNewGoalOpen(true)}>
              <Plus size={13} /> New goal
            </button>
          </div>
        ) : (
          goals.map((goal) => (
            <button
              key={goal.id}
              type="button"
              className={`goal-card ${goal.id === activeGoalId ? 'is-active' : ''}`}
              onClick={() => void selectGoal(goal.id)}
            >
              <div className="goal-card__row">
                <span className="goal-card__title">{goal.title}</span>
                <span className="goal-card__pct">{goal.progress}%</span>
              </div>
              <div className="progress-track">
                <span style={{ width: `${goal.progress}%` }} />
              </div>
              <div className="goal-card__meta">
                <span>{goal.openCount} open</span>
                <span>{goal.phaseCount} phases</span>
                <span className={`goal-status goal-status--${goal.status}`}>{goal.status}</span>
              </div>
            </button>
          ))
        )}
      </div>

      {detail ? (
        <div className="plan-detail">
          <div className="plan-detail__head">
            <div>
              <p className="eyebrow">Selected goal</p>
              <h3>{detail.title}</h3>
            </div>
            <span
              className="progress-orb"
              aria-label={`${detail.progress}% complete`}
              style={{
                background: `radial-gradient(circle at center, var(--color-surface-raised) 0 64%, transparent 65%), conic-gradient(var(--color-accent) 0 ${detail.progress}%, var(--color-line) ${detail.progress}% 100%)`
              }}
            >
              {detail.progress}
              <small>%</small>
            </span>
          </div>
          {detail.summary ? <p className="plan-detail__summary">{detail.summary}</p> : null}
          <div className="plan-detail__actions">
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => setDesignGoal(detail.id)}
            >
              <FileText size={13} /> DESIGN
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={useNextTask}>
              <Sparkles size={13} /> Use next task
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => setWorkbenchTab('loop')}
            >
              <Play size={13} /> Run
            </button>
          </div>

          <div className="phase-list">
            {goalLoading && !detail.phases.length ? (
              <p className="muted small">Loading plan…</p>
            ) : (
              detail.phases.map((phase) => {
                const collapsed = collapsedPhases[phase.id]
                const complete = phase.total > 0 && phase.done === phase.total
                return (
                  <section key={phase.id} className={`phase-block ${complete ? 'is-complete' : ''}`}>
                    <button
                      type="button"
                      className="phase-block__head"
                      onClick={() =>
                        setCollapsedPhases((current) => ({ ...current, [phase.id]: !current[phase.id] }))
                      }
                    >
                      {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <span className="phase-block__index">{String(phase.index).padStart(2, '0')}</span>
                      <span className="phase-block__title">{phase.title}</span>
                      <span className="phase-block__count">
                        {phase.done}/{phase.total}
                      </span>
                    </button>
                    {collapsed ? null : (
                      <ul className="task-list">
                        {phase.tasks.map((task) => (
                          <li key={task.id} className={task.checked ? 'is-checked' : ''}>
                            <button
                              type="button"
                              className="task-check"
                              role="checkbox"
                              aria-checked={task.checked}
                              aria-label={`${task.checked ? 'Reopen' : 'Complete'} ${task.title}`}
                              onClick={() => void toggleTask(detail.id, task.id, !task.checked)}
                            >
                              {task.checked ? <Check size={11} /> : null}
                            </button>
                            <button
                              type="button"
                              className="task-body"
                              title={task.title}
                              onClick={() => {
                                setDraft(
                                  `Implement task ${task.id} of goal ${detail.id}: ${task.title}. Read goals/${detail.id}/DESIGN.md first, then make the change and verify it.`
                                )
                                focusComposer()
                              }}
                            >
                              <span className="task-id">{task.id}</span>
                              <span className="task-title">{task.title}</span>
                            </button>
                          </li>
                        ))}
                        {phase.tasks.length === 0 ? <li className="muted small">No tasks yet.</li> : null}
                      </ul>
                    )}
                  </section>
                )
              })
            )}
          </div>
        </div>
      ) : (
        <div className="rail-empty rail-empty--center">
          <p>Select a goal to inspect its phases.</p>
        </div>
      )}

      <div className="rail__foot">
        {loop.status !== 'idle' ? (
          <button type="button" className="loop-mini" onClick={() => setWorkbenchTab('loop')}>
            <span className={`status-dot status-dot--${loop.status}`} />
            <span>
              <strong>Task loop</strong>
              <small>{stepLabel(loop.currentStep)}</small>
            </span>
            <span className="mono">{loop.completed.filter((task) => task.status === 'committed').length}</span>
          </button>
        ) : (
          <p className="rail__hint">
            <span className="kbd">⌘T</span> tab <span className="kbd">⌘K</span> commands <span className="kbd">esc</span> stop
          </p>
        )}
      </div>
    </aside>
  )
}
