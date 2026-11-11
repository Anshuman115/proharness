import { useEffect, useMemo, useRef, useState } from 'react'
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
  Settings,
  ShieldAlert,
  Square,
  Terminal,
  Zap
} from 'lucide-react'
import { PROVIDER_IDS, type LoopConfig, type ProviderId } from '@shared/types'
import { useAppStore } from '../store'
import { formatClock, permissionModeLabel, stepLabel } from '../lib/format'
import { Markdown } from './Markdown'

const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']

export function LoopPanel(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const goals = useAppStore((state) => state.goals)
  const activeGoalId = useAppStore((state) => state.activeGoalId)
  const loop = useAppStore((state) => state.loop)
  const git = useAppStore((state) => state.git)
  const startLoop = useAppStore((state) => state.startLoop)
  const pauseLoop = useAppStore((state) => state.pauseLoop)
  const resumeLoop = useAppStore((state) => state.resumeLoop)
  const stopLoop = useAppStore((state) => state.stopLoop)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const logRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLPreElement>(null)

  const [goalId, setGoalId] = useState(activeGoalId || goals[0]?.id || '')
  const [reviewerProvider, setReviewerProvider] = useState<ProviderId>(settings?.defaultReviewer || 'deepseek')
  const [reviewerModel, setReviewerModel] = useState(settings?.defaultReviewerModel || 'deepseek-chat')
  const [maxTasks, setMaxTasks] = useState(5)
  const [maxReviewRounds, setMaxReviewRounds] = useState(2)
  const [pauseSeconds, setPauseSeconds] = useState(4)
  const [autoApproveTools, setAutoApproveTools] = useState(true)
  const [permissionMode, setPermissionMode] = useState('acceptEdits')
  const [formError, setFormError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [showForm, setShowForm] = useState(false)

  const active = ['running', 'paused', 'stopping'].includes(loop.status)
  const providerInfo = settings?.providers.find((item) => item.id === reviewerProvider)
  const activeGoal = goals.find((goal) => goal.id === goalId)
  const goalTasks = loop.completed.filter((record) => record.status === 'committed').length
  const total = goalTasks + loop.queue.length + (loop.currentTask ? 1 : 0)
  const progress = total > 0 ? Math.min(100, Math.round((goalTasks / total) * 100)) : 0

  useEffect(() => {
    if (!goalId && (activeGoalId || goals[0])) setGoalId(activeGoalId || goals[0]?.id || '')
  }, [activeGoalId, goalId, goals])

  useEffect(() => {
    if (!settings) return
    setReviewerProvider(settings.defaultReviewer)
    setReviewerModel(settings.defaultReviewerModel)
    // Only seed once when settings first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.defaultReviewer])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [loop.log.length])

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [loop.liveOutput])

  const reviewerOptions = useMemo(() => {
    if (!settings) return []
    return settings.providers.map((provider) => ({
      ...provider,
      model: provider.id === reviewerProvider ? reviewerModel : provider.model
    }))
  }, [settings, reviewerProvider, reviewerModel])

  const onChangeProvider = (provider: ProviderId): void => {
    setReviewerProvider(provider)
    const info = settings?.providers.find((item) => item.id === provider)
    setReviewerModel(info?.model || '')
  }

  const start = async (): Promise<void> => {
    setFormError(null)
    if (!goalId) {
      setFormError('Choose a goal with open tasks.')
      return
    }
    if (!providerInfo?.hasKey) {
      setFormError('Configure the reviewer provider before starting the loop.')
      return
    }
    const config: LoopConfig = {
      goalId,
      reviewerProvider,
      reviewerModel: reviewerModel.trim() || providerInfo.model,
      autoApproveTools,
      maxTasks,
      maxReviewRounds,
      pauseBetweenMs: Math.max(0, pauseSeconds) * 1000,
      commit: true,
      permissionMode: permissionMode as LoopConfig['permissionMode']
    }
    setStarting(true)
    try {
      await startLoop(config)
      setShowForm(false)
    } catch (error) {
      setFormError((error as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="loop-panel">
      <div className="panel-intro">
        <p className="eyebrow">
          <Zap size={11} /> Autonomous task loop
        </p>
        <h3>Work the plan while you watch.</h3>
        <p>
          Each pass picks the next open task, has Claude implement it, sends the diff to an
          independent reviewer, revises on rejection, commits, then checks the task off.
        </p>
      </div>

      {active || (!showForm && ['complete', 'error', 'stopped'].includes(loop.status)) ? (
        <div className="loop-run">
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
              ) : null}
            </div>
          </div>

          <div className="loop-progress">
            <div className="loop-progress__labels">
              <span>{loop.goalTitle}</span>
              <span className="mono">
                {goalTasks}/{Math.max(goalTasks, total)} committed
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
                {['implementing', 'reviewing', 'committing', 'marking'].map((step, index) => {
                  const order = ['implementing', 'reviewing', 'revising', 'committing', 'marking']
                  const currentIndex = order.indexOf(loop.currentStep)
                  const stepIndex = order.indexOf(step)
                  const done = currentIndex > stepIndex
                  const current = loop.currentStep === step || (step === 'reviewing' && loop.currentStep === 'revising')
                  return (
                    <span key={step} className={`loop-step ${done ? 'is-done' : ''} ${current ? 'is-current' : ''}`}>
                      {done ? <Check size={10} /> : current ? <Loader2 size={10} className="spin" /> : <Circle size={8} />}
                      {stepLabel(step)}
                      {index < 3 ? <ChevronRight size={9} /> : null}
                    </span>
                  )
                })}
              </div>
            </div>
          ) : null}

          {loop.review ? (
            <div className={`review-card review-card--${loop.review.verdict === 'APPROVE' ? 'ok' : 'changes'}`}>
              <div className="review-card__head">
                <span className="eyebrow">Independent review</span>
                <span className={`verdict verdict--${loop.review.verdict === 'APPROVE' ? 'ok' : 'changes'}`}>
                  {loop.review.verdict === 'APPROVE' ? <CheckCircle2 size={12} /> : <ShieldAlert size={12} />}
                  {loop.review.verdict}
                </span>
              </div>
              <p className="review-card__who">
                {loop.review.provider} · {loop.review.model}
              </p>
              <div className="review-card__notes">
                <Markdown compact>{loop.review.notes}</Markdown>
              </div>
            </div>
          ) : null}

          {loop.queue.length ? (
            <div className="loop-queue">
              <p className="eyebrow">Queue · {loop.queue.length}</p>
              {loop.queue.slice(0, 6).map((task) => (
                <div key={task.taskId} className="loop-queue__row">
                  <span className="mono">{task.taskId}</span>
                  <span>{task.taskTitle}</span>
                </div>
              ))}
            </div>
          ) : null}

          {loop.liveOutput ? (
            <div className="loop-live">
              <div className="loop-live__head">
                <span className="eyebrow">
                  <Terminal size={11} /> Agent stream
                </span>
                <span className="mono">live</span>
              </div>
              <pre ref={outputRef}>{loop.liveOutput.slice(-18_000)}</pre>
            </div>
          ) : null}

          {loop.completed.some((record) => record.status === 'committed') ? (
            <div className="loop-commits">
              <p className="eyebrow">Committed</p>
              {loop.completed
                .filter((record) => record.status === 'committed')
                .map((record) => (
                  <div key={record.taskId} className="commit-row">
                    <GitCommitHorizontal size={13} />
                    <span className="mono">{record.commitHash || '—'}</span>
                    <span>{record.taskId}</span>
                    <span className="commit-row__title">{record.taskTitle}</span>
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

          {!active ? (
            <button type="button" className="btn btn--quiet btn--full" onClick={() => setShowForm(true)}>
              <Play size={13} /> Configure a new run
            </button>
          ) : null}
        </div>
      ) : (
        <div className="loop-form">
          <div className="field">
            <label htmlFor="loop-goal">Goal</label>
            <select
              id="loop-goal"
              value={goalId}
              onChange={(event) => setGoalId(event.target.value)}
            >
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.title} · {goal.openCount} open
                </option>
              ))}
            </select>
            {activeGoal ? (
              <p className="field-hint">
                {activeGoal.phaseCount} phases · {activeGoal.progress}% complete · plan at goals/{activeGoal.id}/PLAN.md
              </p>
            ) : null}
          </div>

          <div className="field-row">
            <div className="field">
              <label>Reviewer</label>
              <select
                value={reviewerProvider}
                onChange={(event) => onChangeProvider(event.target.value as ProviderId)}
              >
                {PROVIDER_IDS.map((id) => {
                  const info = settings?.providers.find((item) => item.id === id)
                  return (
                    <option key={id} value={id}>
                      {info?.label || id} {info?.hasKey ? '' : '· needs key'}
                    </option>
                  )
                })}
              </select>
            </div>
            <div className="field field--grow">
              <label htmlFor="loop-reviewer-model">Reviewer model</label>
              <input
                id="loop-reviewer-model"
                value={reviewerModel}
                onChange={(event) => setReviewerModel(event.target.value)}
                placeholder={providerInfo?.model}
              />
            </div>
          </div>

          {!providerInfo?.hasKey ? (
            <button type="button" className="loop-warning" onClick={() => setSettingsOpen(true)}>
              <AlertTriangle size={13} />
              {providerInfo?.label || 'Reviewer'} has no API key. Add one in Settings.
              <Settings size={13} />
            </button>
          ) : null}

          <div className="field-row field-row--three">
            <div className="field">
              <label htmlFor="loop-max">Run limit</label>
              <input
                id="loop-max"
                type="number"
                min={1}
                max={50}
                value={maxTasks}
                onChange={(event) => setMaxTasks(Number(event.target.value))}
              />
              <p className="field-hint">tasks this run</p>
            </div>
            <div className="field">
              <label htmlFor="loop-rounds">Review rounds</label>
              <input
                id="loop-rounds"
                type="number"
                min={1}
                max={5}
                value={maxReviewRounds}
                onChange={(event) => setMaxReviewRounds(Number(event.target.value))}
              />
              <p className="field-hint">revisions allowed</p>
            </div>
            <div className="field">
              <label htmlFor="loop-pause">Pause</label>
              <input
                id="loop-pause"
                type="number"
                min={0}
                max={60}
                value={pauseSeconds}
                onChange={(event) => setPauseSeconds(Number(event.target.value))}
              />
              <p className="field-hint">seconds between tasks</p>
            </div>
          </div>

          <div className="field-row">
            <div className="field field--grow">
              <label htmlFor="loop-mode">Claude permission mode</label>
              <select
                id="loop-mode"
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value)}
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {permissionModeLabel(mode)} · {mode}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Auto-approve tools</label>
              <button
                type="button"
                className={`switch ${autoApproveTools ? 'is-on' : ''}`}
                role="switch"
                aria-checked={autoApproveTools}
                onClick={() => setAutoApproveTools((value) => !value)}
              >
                <span />
                {autoApproveTools ? 'on' : 'off'}
              </button>
            </div>
          </div>

          {autoApproveTools ? (
            <div className="loop-warning loop-warning--danger">
              <ShieldAlert size={13} />
              The implementer can run shell commands without a dialog. The independent review and
              commit gate still apply, and Stop interrupts the current action.
            </div>
          ) : null}

          <div className="loop-guarantees">
            <span>
              <GitCommitHorizontal size={12} /> commits each task
            </span>
            <span>
              <CheckCircle2 size={12} /> checks off PLAN.md
            </span>
            <span>
              <ShieldAlert size={12} /> other-model review
            </span>
          </div>

          {!git?.clean ? (
            <div className="loop-warning">
              <AlertTriangle size={13} />
              Commit or stash {git?.files.length || 'current'} working-tree changes before starting.
            </div>
          ) : null}

          {formError ? <div className="inline-error">{formError}</div> : null}

          <button
            type="button"
            className="btn btn--accent btn--lg btn--full"
            onClick={() => void start()}
            disabled={starting || !git?.clean || !providerInfo?.hasKey}
          >
            {starting ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {starting ? 'Checking worktree…' : 'Start autonomous loop'}
          </button>
          <p className="loop-fineprint">
            The loop refuses to run on a dirty tree. If the reviewer rejects after the revision
            limit, it halts with the diff intact and nothing committed.
          </p>
        </div>
      )}
    </div>
  )
}
