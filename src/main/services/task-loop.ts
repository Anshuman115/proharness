import { randomUUID } from 'node:crypto'
import type {
  GoalDetail,
  LoopConfig,
  LoopEvent,
  LoopLogEntry,
  LoopState,
  LoopTaskRecord,
  SessionEvent,
  TaskRef,
  Verdict
} from '@shared/types'
import type { TurnResult } from '../omp/agent'
import type { GitService } from './git'
import type { PlanService } from './plan'
import { buildReviewPrompt, parseReview, REVIEWER_SYSTEM, sameModel } from './review'

const TASK_TIMEOUT_MS = 30 * 60_000
const REVIEW_TIMEOUT_MS = 15 * 60_000

/** The slice of an omp agent the loop needs; tests substitute a fake. */
export interface LoopAgent {
  start(): Promise<void>
  runTurn(text: string, signal: AbortSignal): Promise<TurnResult>
  close(): Promise<void>
}

export interface LoopAgentFactory {
  implementer(options: { model: string; approval: LoopConfig['approval']; label: string; onEvent: (event: SessionEvent) => void }): Promise<LoopAgent>
  reviewer(options: { model: string; label: string; onEvent: (event: SessionEvent) => void }): Promise<LoopAgent>
  /** omp's configured default model, used when the implementer model is blank. */
  defaultModel(): string | null
}

function emptyState(): LoopState {
  return {
    runId: null,
    status: 'idle',
    goalId: null,
    goalTitle: null,
    config: null,
    currentTask: null,
    currentStep: 'idle',
    queue: [],
    completed: [],
    log: [],
    liveOutput: '',
    liveTool: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    review: null,
    costUsd: 0
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function openTasks(goal: GoalDetail): TaskRef[] {
  return goal.phases.flatMap((phase) =>
    phase.tasks
      .filter((task) => !task.checked)
      .map((task) => ({ goalId: goal.id, taskId: task.id, taskTitle: task.title, phaseTitle: phase.title }))
  )
}

function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  timer.unref()
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Works through a goal's PLAN.md: implement the next open task with one omp
 * model, review the diff with a different model, revise, commit the code,
 * then check the task off. goals/ is never committed.
 */
export class TaskLoopService {
  private state: LoopState = emptyState()
  private emit: (event: LoopEvent) => void = () => undefined
  private abortController: AbortController | null = null
  private implementer: LoopAgent | null = null

  constructor(
    private readonly plan: PlanService,
    private readonly git: GitService,
    private readonly agents: LoopAgentFactory
  ) {}

  setEmitter(emitter: (event: LoopEvent) => void): void {
    this.emit = emitter
  }

  getState(): LoopState {
    return this.snapshot()
  }

  private snapshot(): LoopState {
    return JSON.parse(JSON.stringify(this.state)) as LoopState
  }

  private emitState(): void {
    this.emit({ type: 'state', state: this.snapshot() })
  }

  private log(level: LoopLogEntry['level'], message: string): void {
    const entry: LoopLogEntry = { ts: Date.now(), level, message }
    this.state.log.push(entry)
    if (this.state.log.length > 400) this.state.log.splice(0, this.state.log.length - 400)
    this.emit({ type: 'log', entry })
    this.emitState()
  }

  private setStep(step: LoopState['currentStep']): void {
    this.state.currentStep = step
    this.state.liveTool = null
    this.emitState()
  }

  private appendOutput(text: string): void {
    if (!text) return
    this.state.liveOutput = `${this.state.liveOutput}${text}`
    if (this.state.liveOutput.length > 80_000) this.state.liveOutput = this.state.liveOutput.slice(-60_000)
    this.emit({ type: 'delta', text })
  }

  private onAgentEvent = (event: SessionEvent): void => {
    if (event.type === 'delta') {
      // Thinking deltas share the stream; only surface visible text.
      this.appendOutput(event.text)
    } else if (event.type === 'block' && event.block.type === 'tool') {
      const label = `${event.block.name}${event.block.intent ? ` · ${event.block.intent}` : ''}`
      this.state.liveTool = label
      this.emit({ type: 'tool', label })
    } else if (event.type === 'message_start') {
      if (this.state.liveOutput && !this.state.liveOutput.endsWith('\n')) this.appendOutput('\n')
    } else if (event.type === 'notice' && event.level !== 'info') {
      this.log(event.level, event.message)
    }
  }

  async start(config: LoopConfig): Promise<LoopState> {
    if (['running', 'paused', 'stopping'].includes(this.state.status)) {
      throw new Error('A task loop is already active. Stop it before starting another.')
    }
    const implementerModel = config.implementerModel.trim() || this.agents.defaultModel() || ''
    const reviewerModel = config.reviewerModel.trim()
    if (!reviewerModel) throw new Error('Choose a reviewer model.')
    if (implementerModel && sameModel(implementerModel, reviewerModel)) {
      throw new Error('The reviewer must be a different model from the implementer.')
    }
    const goal = await this.plan.readGoal(config.goalId)
    if (!goal.openCount) throw new Error('This goal has no open tasks.')
    const git = await this.git.summary()
    if (!git.isRepo) throw new Error('The workspace is not a git repository.')
    if (!git.clean) {
      throw new Error(
        `The working tree has ${git.files.length} uncommitted change(s). Commit or stash them first so each loop commit holds one task.`
      )
    }
    await this.git.excludeGoals()

    const normalized: LoopConfig = {
      ...config,
      implementerModel,
      reviewerModel,
      maxTasks: clamp(config.maxTasks, 1, 50),
      maxReviewRounds: clamp(config.maxReviewRounds, 1, 5),
      pauseBetweenMs: clamp(config.pauseBetweenMs, 0, 60_000)
    }

    this.state = emptyState()
    this.state.runId = randomUUID()
    this.state.status = 'running'
    this.state.goalId = goal.id
    this.state.goalTitle = goal.title
    this.state.config = normalized
    this.state.queue = openTasks(goal)
    this.state.startedAt = Date.now()
    this.state.currentStep = 'preflight'
    this.abortController = new AbortController()

    this.log(
      'info',
      `Starting "${goal.title}". Implementer ${implementerModel || 'omp default'}, reviewer ${reviewerModel}, approvals ${normalized.approval}.`
    )
    if (!git.branch) this.log('warn', 'HEAD is detached. Commits will not land on a branch.')
    if (normalized.approval === 'yolo') {
      this.log('warn', 'Approvals are off (yolo). The implementer runs commands without asking; the review gate and Stop still apply.')
    }
    this.emitState()
    void this.run(normalized)
    return this.snapshot()
  }

  async pause(): Promise<LoopState> {
    if (this.state.status !== 'running') return this.snapshot()
    this.state.status = 'paused'
    this.log('info', 'Pausing after the current step.')
    return this.snapshot()
  }

  async resume(): Promise<LoopState> {
    if (this.state.status !== 'paused') return this.snapshot()
    this.state.status = 'running'
    this.log('info', 'Resuming.')
    return this.snapshot()
  }

  async stop(): Promise<LoopState> {
    if (!['running', 'paused', 'stopping'].includes(this.state.status)) return this.snapshot()
    this.state.status = 'stopping'
    this.log('warn', 'Stopping: interrupting the current step.')
    this.abortController?.abort()
    return this.snapshot()
  }

  private async checkpoint(signal: AbortSignal): Promise<void> {
    while (this.state.status === 'paused') await delay(250, signal)
    if (this.state.status !== 'running') throw new Error('aborted')
  }

  private recordFor(task: TaskRef): LoopTaskRecord {
    return {
      taskId: task.taskId,
      taskTitle: task.taskTitle,
      phaseTitle: task.phaseTitle,
      status: 'running',
      attempts: 0,
      reviewVerdict: null,
      reviewNotes: null,
      commitHash: null,
      costUsd: 0,
      startedAt: Date.now(),
      finishedAt: null,
      error: null
    }
  }

  private implementPrompt(goal: GoalDetail, task: TaskRef): string {
    return [
      'You are the implementation agent in an autonomous ProHarness task loop.',
      `Goal: ${goal.title} (${goal.id})`,
      `Phase: ${task.phaseTitle}`,
      `Task: ${task.taskTitle} (id ${task.taskId})`,
      '',
      `Read goals/${goal.id}/DESIGN.md and goals/${goal.id}/PLAN.md (or call plan_read) before editing.`,
      'Implement this task and only this task. Keep the change set tightly scoped.',
      'Run the most relevant checks you can (typecheck, tests, build) and fix failures you introduce.',
      'Do not commit, do not edit goals/, and do not start the next task. The loop commits, reviews and checks off.',
      'If a step is impossible or needs a secret, say so plainly in your final answer instead of faking it.',
      'Finish with a short summary of what changed and how you verified it.'
    ].join('\n')
  }

  private revisionPrompt(goal: GoalDetail, task: TaskRef, notes: string): string {
    return [
      'An independent reviewer examined your working-tree changes and requested changes.',
      `Goal: ${goal.title} (${goal.id})`,
      `Task: ${task.taskTitle} (id ${task.taskId})`,
      '',
      'Reviewer findings:',
      notes,
      '',
      'Fix the findings in the working tree while keeping the original task scope.',
      'Do not commit and do not edit goals/. Re-run relevant checks after fixing.',
      'Finish with a short list of what you changed in response to the review.'
    ].join('\n')
  }

  private async implement(text: string, signal: AbortSignal, record: LoopTaskRecord): Promise<void> {
    if (!this.implementer) throw new Error('The implementer is not running.')
    this.state.liveOutput = ''
    const scope = withTimeout(signal, TASK_TIMEOUT_MS)
    try {
      const result = await this.implementer.runTurn(text, scope.signal)
      record.costUsd += result.costUsd
      this.state.costUsd += result.costUsd
      if (scope.timedOut()) throw new Error(`The implementer timed out after ${TASK_TIMEOUT_MS / 60_000} minutes.`)
      if (signal.aborted) throw new Error('aborted')
      if (result.status === 'aborted') throw new Error('The implementer was interrupted.')
      if (result.status === 'error') throw new Error(result.error || 'The implementer failed.')
    } finally {
      scope.dispose()
    }
  }

  private async review(
    goal: GoalDetail,
    task: TaskRef,
    config: LoopConfig,
    signal: AbortSignal,
    record: LoopTaskRecord
  ): Promise<{ verdict: Verdict; notes: string }> {
    const { summary, diff, truncated } = await this.git.reviewDiff()
    if (!summary.files.length) throw new Error('The implementer produced no code changes outside goals/.')
    this.setStep(record.attempts > 1 ? 'reviewing' : 'reviewing')
    this.log('info', `Reviewing ${summary.files.length} changed file(s) with ${config.reviewerModel}.`)
    const prompt = `${REVIEWER_SYSTEM}\n\n${buildReviewPrompt({
      goal: { id: goal.id, title: goal.title },
      task,
      design: goal.design,
      diff,
      diffTruncated: truncated
    })}`
    this.state.liveOutput = ''
    const reviewer = await this.agents.reviewer({
      model: config.reviewerModel,
      label: `Review · ${task.taskId}`,
      onEvent: this.onAgentEvent
    })
    const scope = withTimeout(signal, REVIEW_TIMEOUT_MS)
    let result: TurnResult
    try {
      await reviewer.start()
      result = await reviewer.runTurn(prompt, scope.signal)
    } finally {
      scope.dispose()
      await reviewer.close().catch(() => undefined)
    }
    record.costUsd += result.costUsd
    this.state.costUsd += result.costUsd
    if (signal.aborted) throw new Error('aborted')
    if (scope.timedOut()) throw new Error('The reviewer timed out. Nothing was committed.')
    if (result.status !== 'completed') {
      throw new Error(`The reviewer failed: ${result.error || result.status}. Nothing was committed.`)
    }
    const parsed = parseReview(result.text)
    this.state.review = { verdict: parsed.verdict, summary: parsed.summary, notes: parsed.notes, model: config.reviewerModel }
    this.log(
      parsed.verdict === 'APPROVE' ? 'success' : 'warn',
      `Reviewer: ${parsed.verdict}${parsed.summary ? ` — ${parsed.summary}` : ''}`
    )
    if (parsed.parseWarning) this.log('warn', parsed.parseWarning)
    return { verdict: parsed.verdict, notes: parsed.notes }
  }

  private commitMessage(goal: GoalDetail, task: TaskRef, config: LoopConfig): string {
    return [
      `${task.taskId}: ${task.taskTitle}`.slice(0, 100),
      '',
      `Goal: ${goal.title}`,
      `Phase: ${task.phaseTitle}`,
      `Implemented-by: ${config.implementerModel || 'omp default'}`,
      `Reviewed-by: ${config.reviewerModel} (APPROVE)`
    ].join('\n')
  }

  private async executeTask(goal: GoalDetail, task: TaskRef, config: LoopConfig, record: LoopTaskRecord, signal: AbortSignal): Promise<void> {
    this.state.currentTask = task
    this.state.review = null
    this.setStep('implementing')
    this.log('info', `Implementing ${task.taskId}: ${task.taskTitle}`)

    record.attempts = 1
    await this.implement(this.implementPrompt(goal, task), signal, record)
    await this.checkpoint(signal)

    record.status = 'reviewing'
    let review = await this.review(goal, task, config, signal, record)
    let rounds = 0
    while (review.verdict === 'REQUEST_CHANGES') {
      if (rounds >= config.maxReviewRounds) {
        throw new Error(`Reviewer still requested changes after ${rounds} revision(s). The diff is left in the working tree; nothing was committed.`)
      }
      rounds += 1
      record.status = 'revising'
      record.reviewVerdict = 'REQUEST_CHANGES'
      record.reviewNotes = review.notes
      record.attempts += 1
      await this.checkpoint(signal)
      this.setStep('revising')
      this.log('warn', `Revision ${rounds}/${config.maxReviewRounds}: sending findings back to the implementer.`)
      await this.implement(this.revisionPrompt(goal, task, review.notes), signal, record)
      await this.checkpoint(signal)
      review = await this.review(goal, task, config, signal, record)
    }

    record.reviewVerdict = 'APPROVE'
    record.reviewNotes = review.notes
    await this.checkpoint(signal)

    this.setStep('committing')
    const commit = await this.git.commitAll(this.commitMessage(await this.plan.readGoal(goal.id), task, config))
    record.commitHash = commit.hash
    this.log('success', `Committed ${commit.hash}.`)

    this.setStep('marking')
    await this.plan.setTaskChecked(goal.id, task.taskId, true, `${commit.hash} · reviewed by ${config.reviewerModel}`)
    this.log('info', `Checked off ${task.taskId} in goals/${goal.id}/PLAN.md (local, not committed).`)

    record.status = 'committed'
    record.finishedAt = Date.now()
    this.state.queue = this.state.queue.filter((item) => item.taskId !== task.taskId)
    this.emitState()
  }

  private async run(config: LoopConfig): Promise<void> {
    const signal = this.abortController!.signal
    try {
      this.implementer = await this.agents.implementer({
        model: config.implementerModel,
        approval: config.approval,
        label: `Loop · ${this.state.goalTitle || config.goalId}`,
        onEvent: this.onAgentEvent
      })
      await this.implementer.start()

      while (true) {
        await this.checkpoint(signal)
        const committed = this.state.completed.filter((record) => record.status === 'committed').length
        if (committed >= config.maxTasks) {
          this.log('info', `Reached the run limit of ${config.maxTasks} task(s).`)
          this.state.status = 'complete'
          this.state.currentStep = 'complete'
          break
        }
        const tree = await this.git.summary()
        if (!tree.clean) {
          throw new Error(`The working tree changed between tasks (${tree.files.length} file(s)). Stopped so a commit cannot absorb unrelated work.`)
        }
        const goal = await this.plan.readGoal(config.goalId)
        this.state.goalTitle = goal.title
        this.state.queue = openTasks(goal)
        const task = await this.plan.nextTask(config.goalId)
        if (!task) {
          this.state.status = 'complete'
          this.state.currentStep = 'complete'
          this.state.currentTask = null
          this.log('success', 'Every task in this goal is complete.')
          break
        }
        const record = this.recordFor(task)
        this.state.completed.push(record)
        this.state.queue = this.state.queue.filter((item) => item.taskId !== task.taskId)
        try {
          await this.executeTask(goal, task, config, record, signal)
        } catch (error) {
          record.status = 'failed'
          record.error = (error as Error).message
          record.finishedAt = Date.now()
          throw error
        }
        if (config.pauseBetweenMs > 0) {
          this.state.currentStep = 'waiting'
          this.emitState()
          await delay(config.pauseBetweenMs, signal)
        }
      }
    } catch (error) {
      if (this.state.status === 'stopping' || signal.aborted) {
        this.state.status = 'stopped'
        this.state.currentStep = 'idle'
        this.log('warn', 'Loop stopped. Uncommitted work, if any, is still in the working tree.')
      } else {
        this.state.status = 'error'
        this.state.error = (error as Error).message
        this.state.currentStep = 'error'
        this.log('error', (error as Error).message)
      }
    } finally {
      const implementer = this.implementer
      this.implementer = null
      await implementer?.close().catch(() => undefined)
      if (this.state.status === 'running' || this.state.status === 'paused') this.state.status = 'complete'
      this.state.finishedAt = Date.now()
      this.state.liveTool = null
      if (this.state.status !== 'error') this.state.currentTask = null
      this.abortController = null
      this.emitState()
    }
  }

  dispose(): void {
    this.abortController?.abort()
    void this.implementer?.close()
  }
}
