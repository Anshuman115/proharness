import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  GitCommitHorizontal,
  Loader2,
  Pause,
  Play,
  ShieldAlert,
  Square,
  Wrench
} from 'lucide-react'
import { isLoopLive, LOOP_LIMITS } from '@shared/defaults'
import { shortModel } from '@shared/models'
import { APPROVAL_MODES, type ApprovalMode, type LoopConfig } from '@shared/types'
import { useAppStore } from '../store'
import { approvalHint, approvalLabel, formatClock, formatCost, stepLabel } from '../lib/format'
import { Markdown } from './Markdown'
import { ModelNotes, ModelPicker } from './ModelPicker'

const STEPS = ['implementing', 'reviewing', 'committing', 'marking'] as const

export function LoopPanel(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const omp = useAppStore((state) => state.omp)
  const goals = useAppStore((state) => state.goals)
  const activeGoalId = useAppStore((state) => state.activeGoalId)
  const loop = useAppStore((state) => state.loop)
  const git = useAppStore((state) => state.git)
  const startLoop = useAppStore((state) => state.startLoop)
  const pauseLoop = useAppStore((state) => state.pauseLoop)
  const resumeLoop = useAppStore((state) => state.resumeLoop)
  const stopLoop = useAppStore((state) => state.stopLoop)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const pushToast = useAppStore((state) => state.pushToast)
  const logRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLPreElement>(null)

  const [goalId, setGoalId] = useState(activeGoalId || goals[0]?.id || '')
  const [implementer, setImplementer] = useState(settings?.implementerModel || '')
  const [reviewer, setReviewer] = useState(settings?.reviewerModel || '')
  const [approval, setApproval] = useState<ApprovalMode>(settings?.loopApproval || 'yolo')
  const [maxTasks, setMaxTasks] = useState(5)
  const [maxReviewRounds, setMaxReviewRounds] = useState(2)
  const [formError, setFormError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [showForm, setShowForm] = useState(false)

  const active = isLoopLive(loop.status)
  const goal = goals.find((item) => item.id === goalId)
  const committed = loop.completed.filter((record) => record.status === 'committed')
  const total = committed.length + loop.queue.length + (loop.currentTask && loop.status !== 'complete' ? 1 : 0)
  const progress = total > 0 ? Math.round((committed.length / total) * 100) : 0
  const effectiveImplementer = implementer || omp?.defaultModel || ''

  // Follow the host's defaults on host change; catalog refreshes keep the user's edits.
  useEffect(() => {
    setImplementer(settings?.implementerModel || '')
    setReviewer(settings?.reviewerModel || '')
    setApproval(settings?.loopApproval || 'yolo')
  }, [settings?.workspaceHost])

  useEffect(() => {
    if ((!goalId || !goals.some((item) => item.id === goalId)) && (activeGoalId || goals[0])) setGoalId(activeGoalId || goals[0]?.id || '')
  }, [activeGoalId, goalId, goals])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [loop.log.length])

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [loop.liveOutput])

  const start = async (): Promise<void> => {
    setFormError(null)
    if (!goalId) return setFormError('Choose a goal with open tasks.')
    if (!reviewer) return setFormError('Choose a reviewer model.')
    const config: LoopConfig = {
      goalId,
      implementerModel: implementer,
      reviewerModel: reviewer,
      approval,
      maxTasks,
      maxReviewRounds,
      pauseBetweenMs: 2_000
    }
    setStarting(true)
    try {
      await startLoop(config)
      setShowForm(false)
      void updateSettings({ implementerModel: implementer, reviewerModel: reviewer, loopApproval: approval }).catch((error: Error) =>
        pushToast('error', error.message)
      )
    } catch (error) {
      setFormError((error as Error).message)
    } finally {
      setStarting(false)
    }
  }

  if (active || (!showForm && ['complete', 'error', 'stopped'].includes(loop.status))) {
    const stepIndex = (STEPS as readonly string[]).indexOf(loop.currentStep === 'revising' ? 'reviewing' : loop.currentStep)
    return (
      <div className="loop-panel">
        <div className="loop-run__head">
          <div className={`loop-state loop-state--${loop.status}`}>
            <span className="status-dot" />
            <strong>{loop.status}</strong>
            <span>{stepLabel(loop.currentStep)}</span>
          </div>
          <div className="loop-run__controls">
            {loop.status === 'running' ? (
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => void pauseLoop()}>
                <Pause size={12} /> Pause
              </button>
            ) : null}
            {loop.status === 'paused' ? (
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => void resumeLoop()}>
                <Play size={12} /> Resume
              </button>
            ) : null}
            {active ? (
              <button type="button" className="btn btn--danger btn--sm" onClick={() => void stopLoop()}>
                <Square size={11} /> Stop
              </button>
            ) : (
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => setShowForm(true)}>
                <Play size={12} /> New run
              </button>
            )}
          </div>
        </div>

        <div className="loop-models">
          <span>
            <span className="loop-models__role">builds</span> {shortModel(loop.config?.implementerModel)}
          </span>
          <ChevronRight size={11} />
          <span>
            <span className="loop-models__role">reviews</span> {shortModel(loop.config?.reviewerModel)}
          </span>
          <span className="loop-models__cost mono">{formatCost(loop.costUsd)}</span>
        </div>

        <div className="loop-progress">
          <div className="loop-progress__labels">
            <span>{loop.goalTitle}</span>
            <span className="mono">
              {committed.length}/{Math.max(committed.length, total)} committed
            </span>
          </div>
          <div className="progress-track progress-track--lg">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>

        {loop.error ? (
          <div className="inline-error">
            <AlertTriangle size={13} /> {loop.error}
          </div>
        ) : null}

        {loop.currentTask ? (
          <div className="loop-task">
            <div className="loop-task__eyebrow">
              <span className="mono">{loop.currentTask.taskId}</span>
              <span>{loop.currentTask.phaseTitle}</span>
            </div>
            <h4>{loop.currentTask.taskTitle}</h4>
            <div className="loop-task__steps">
              {STEPS.map((step, index) => {
                const current = index === stepIndex
                const done = stepIndex > index
                return (
                  <span key={step} className={`loop-step ${done ? 'is-done' : ''} ${current ? 'is-current' : ''}`}>
                    {done ? <Check size={10} /> : current ? <Loader2 size={10} className="spin" /> : <Circle size={8} />}
                    {step === 'reviewing' && loop.currentStep === 'revising' ? 'Revising' : stepLabel(step)}
                    {index < STEPS.length - 1 ? <ChevronRight size={9} /> : null}
                  </span>
                )
              })}
            </div>
            {loop.liveTool && active ? (
              <div className="loop-task__tool">
                <Wrench size={11} /> {loop.liveTool}
              </div>
            ) : null}
          </div>
        ) : null}

        {loop.review ? (
          <div className={`review-card review-card--${loop.review.verdict === 'APPROVE' ? 'ok' : 'changes'}`}>
            <div className="review-card__head">
              <span className="eyebrow">Review · {shortModel(loop.review.model)}</span>
              <span className={`verdict verdict--${loop.review.verdict === 'APPROVE' ? 'ok' : 'changes'}`}>
                {loop.review.verdict === 'APPROVE' ? <CheckCircle2 size={12} /> : <ShieldAlert size={12} />}
                {loop.review.verdict === 'APPROVE' ? 'Approved' : 'Changes requested'}
              </span>
            </div>
            <div className="review-card__notes">
              <Markdown compact>{loop.review.notes}</Markdown>
            </div>
          </div>
        ) : null}

        {loop.liveOutput ? (
          <div className="loop-live">
            <div className="loop-live__head">
              <span className="eyebrow">Agent output</span>
              {active ? <span className="live-tag">live</span> : null}
            </div>
            <pre ref={outputRef}>{loop.liveOutput.slice(-16_000)}</pre>
          </div>
        ) : null}

        {committed.length ? (
          <div className="loop-commits">
            <p className="eyebrow">Commits</p>
            {committed.map((record) => (
              <div key={record.taskId} className="commit-row">
                <GitCommitHorizontal size={13} />
                <span className="mono">{record.commitHash || '—'}</span>
                <span className="commit-row__title">
                  {record.taskId} {record.taskTitle}
                </span>
                {record.attempts > 1 ? <span className="mini-chip">{record.attempts} tries</span> : null}
              </div>
            ))}
          </div>
        ) : null}

        {loop.queue.length ? (
          <div className="loop-queue">
            <p className="eyebrow">Up next · {loop.queue.length}</p>
            {loop.queue.slice(0, 5).map((task) => (
              <div key={task.taskId} className="loop-queue__row">
                <span className="mono">{task.taskId}</span>
                <span>{task.taskTitle}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="loop-log" ref={logRef}>
          {loop.log.map((entry, index) => (
            <div key={`${entry.ts}-${index}`} className={`log-line log-line--${entry.level}`}>
              <span className="log-line__time">{formatClock(entry.ts)}</span>
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="loop-panel">
      <div className="panel-intro">
        <p className="eyebrow">Autonomous loop</p>
        <h3>Work through a plan, task by task.</h3>
        <p>
          Picks the next open task, implements it, has a different model review the diff, revises if asked, commits the
          code, then checks the task off in PLAN.md. goals/ itself is never committed.
        </p>
      </div>

      <div className="loop-form">
        <div className="field">
          <label htmlFor="loop-goal">Goal</label>
          <select id="loop-goal" value={goalId} onChange={(event) => setGoalId(event.target.value)}>
            {goals.length === 0 ? <option value="">No goals yet</option> : null}
            {goals.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.openCount} open
              </option>
            ))}
          </select>
          {goal ? (
            <p className="field-hint">
              {goal.phaseCount} phases · {goal.progress}% done · goals/{goal.id}/PLAN.md
            </p>
          ) : null}
        </div>

        <div className="loop-roles">
          <div className="field">
            <label>Implementer</label>
            <ModelPicker value={implementer} onChange={setImplementer} emptyLabel="omp default" ariaLabel="Implementer model" />
          </div>
          <div className="field">
            <label>Reviewer</label>
            <ModelPicker value={reviewer} onChange={setReviewer} ariaLabel="Reviewer model" align="right" />
          </div>
        </div>
        <ModelNotes />
        {effectiveImplementer && reviewer && shortModel(effectiveImplementer) === shortModel(reviewer) ? (
          <div className="loop-warning">
            <AlertTriangle size={13} /> Pick a reviewer that is a different model from the implementer.
          </div>
        ) : null}

        <div className="field">
          <label>Implementer approvals</label>
          <div className="segmented">
            {APPROVAL_MODES.filter((mode) => mode !== 'always-ask-cached').map((mode) => (
              <button key={mode} type="button" className={approval === mode ? 'is-active' : ''} onClick={() => setApproval(mode)}>
                {approvalLabel(mode)}
              </button>
            ))}
          </div>
          <p className="field-hint">{approvalHint(approval)}. Prompts pause the loop until you answer.</p>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="loop-max">Tasks this run</label>
            <input
              id="loop-max"
              type="number"
              min={LOOP_LIMITS.maxTasks[0]}
              max={LOOP_LIMITS.maxTasks[1]}
              value={maxTasks}
              onChange={(event) => setMaxTasks(Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="loop-rounds">Revision rounds</label>
            <input
              id="loop-rounds"
              type="number"
              min={LOOP_LIMITS.maxReviewRounds[0]}
              max={LOOP_LIMITS.maxReviewRounds[1]}
              value={maxReviewRounds}
              onChange={(event) => setMaxReviewRounds(Number(event.target.value))}
            />
          </div>
        </div>

        {git && !git.clean ? (
          <div className="loop-warning">
            <AlertTriangle size={13} /> Commit or stash {git.files.length} change(s) first. Each loop commit should hold exactly one task.
          </div>
        ) : null}
        {formError ? <div className="inline-error">{formError}</div> : null}

        <button
          type="button"
          className="btn btn--accent btn--lg btn--full"
          onClick={() => void start()}
          disabled={starting || !git?.clean || !goal?.openCount || !reviewer}
        >
          {starting ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
          {starting ? 'Checking…' : 'Start loop'}
        </button>
        <p className="loop-fineprint">
          If the reviewer keeps rejecting after the revision limit, the loop stops with the diff left in place and nothing
          committed.
        </p>
      </div>
    </div>
  )
}
