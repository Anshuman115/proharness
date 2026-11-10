import { randomUUID } from 'node:crypto'
import {
  PROVIDER_LABELS,
  type GoalDetail,
  type LoopConfig,
  type LoopEvent,
  type LoopLogEntry,
  type LoopState,
  type LoopTaskRecord,
  type ProviderId,
  type TaskRef
} from '@shared/types'
import type { ClaudeService } from './claude'
import type { GitService } from './git'
import type { PlanService } from './plan'
import type { ProviderService } from './providers'
import type { SettingsService } from './settings'
import { buildReviewPrompt, parseReview } from './review'

const TASK_TIMEOUT_MS = 20 * 60_000

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
    startedAt: null,
    finishedAt: null,
    error: null,
    review: null
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
  const tasks: TaskRef[] = []
  for (const phase of goal.phases) {
    for (const task of phase.tasks) {
      if (!task.checked) {
        tasks.push({
          goalId: goal.id,
          taskId: task.id,
          taskTitle: task.title,
          phaseTitle: phase.title
        })
      }
    }
  }
  return tasks
}

export class TaskLoopService {
  private state: LoopState = emptyState()
  private emit: (event: LoopEvent) => void = () => undefined
  private abortController: AbortController | null = null
  private active = false
  private alwaysAllowed = new Set<string>()

  constructor(
    private readonly settings: SettingsService,
    private readonly plan: PlanService,
    private readonly git: GitService,
    private readonly providers: ProviderService,
    private readonly claude: ClaudeService
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
    if (this.state.log.length > 350) this.state.log.splice(0, this.state.log.length - 350)
    this.emit({ type: 'log', entry })
    this.emitState()
  }

  private setStep(step: LoopState['currentStep']): void {
    this.state.currentStep = step
    this.emit({ type: 'step', step, task: this.state.currentTask })
    this.emitState()
  }

  private appendOutput(text: string): void {
    if (!text) return
    this.state.liveOutput = `${this.state.liveOutput}${text}`
    if (this.state.liveOutput.length > 80_000) {
      this.state.liveOutput = this.state.liveOutput.slice(-60_000)
    }
    this.emit({ type: 'delta', text })
  }

  private reviewerLabel(config: LoopConfig): string {
    return `${PROVIDER_LABELS[config.reviewerProvider]} · ${config.reviewerModel || this.settings.defaultReviewerModel}`
  }

  async start(config: LoopConfig): Promise<LoopState> {
    if (this.state.status === 'running' || this.state.status === 'paused' || this.state.status === 'stopping') {
      throw new Error('A task loop is already active. Stop it before starting another.')
    }
    if (!config.commit) {
      throw new Error('The autonomous loop requires commits so each task stays isolated.')
    }
    if (!this.providers.getConfigured(config.reviewerProvider)) {
      throw new Error(
        `${PROVIDER_LABELS[config.reviewerProvider]} is not configured. Add its API key in Settings before running the loop.`
      )
    }

    const goal = this.plan.readGoal(config.goalId)
    if (!goal.openCount) throw new Error('This goal has no open tasks.')
    const git = await this.git.summary()
    if (!git.isRepo) throw new Error('The workspace is not a git repository.')
    if (!git.clean) {
      throw new Error(
        `The working tree has ${git.files.length} uncommitted change(s). Commit or stash them before starting the loop so its commits stay scoped.`
      )
    }

    const normalized: LoopConfig = {
      ...config,
      maxTasks: clamp(config.maxTasks, 1, 50),
      maxReviewRounds: clamp(config.maxReviewRounds, 1, 5),
      pauseBetweenMs: clamp(config.pauseBetweenMs, 0, 60_000),
      reviewerModel: config.reviewerModel || this.settings.defaultReviewerModel,
      permissionMode: config.permissionMode || 'acceptEdits'
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
    this.alwaysAllowed = new Set()

    this.log('info', `Starting goal "${goal.title}" with reviewer ${this.reviewerLabel(normalized)}.`)
    if (!git.branch) this.log('warn', 'HEAD is detached. Commits will not land on a branch.')
    if (normalized.autoApproveTools) {
      this.log(
        'warn',
        'Tool auto-approval is ON. The implementer can run shell commands without asking. Review the diff gate and stop button remain active.'
      )
    }
    this.emitState()
    void this.run(normalized)
    return this.snapshot()
  }

  async pause(): Promise<LoopState> {
    if (this.state.status !== 'running') return this.snapshot()
    this.state.status = 'paused'
    this.log('info', 'Pause requested. The loop will pause after the current step.')
    this.emitState()
    return this.snapshot()
  }

  async resume(): Promise<LoopState> {
    if (this.state.status !== 'paused') return this.snapshot()
    this.state.status = 'running'
    this.log('info', 'Resuming task loop.')
    this.emitState()
    return this.snapshot()
  }

  async stop(): Promise<LoopState> {
    if (!['running', 'paused', 'stopping'].includes(this.state.status)) return this.snapshot()
    this.state.status = 'stopping'
    this.log('warn', 'Stopping task loop after the current action is interrupted.')
    this.abortController?.abort()
    this.emitState()
    return this.snapshot()
  }

  private async waitWhilePaused(signal: AbortSignal): Promise<void> {
    while (this.state.status === 'paused') {
      await delay(250, signal)
    }
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
      startedAt: Date.now(),
      finishedAt: null,
      error: null
    }
  }

  private async runAgent(
    prompt: string,
    resume: string | null,
    signal: AbortSignal,
    title: string
  ): Promise<{ text: string; sessionId: string | null; error: string | null; aborted: boolean }> {
    const controller = new AbortController()
    let timedOut = false
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, TASK_TIMEOUT_MS)
    timer.unref()
    this.state.liveOutput = ''
    if (signal.aborted) controller.abort()

    try {
      const result = await this.claude.runTurn({
        cwd: this.settings.workspacePath,
        prompt,
        resume,
        model: this.settings.claudeModel,
        permissionMode: this.state.config?.permissionMode || 'acceptEdits',
        origin: 'loop',
        originId: this.state.runId || 'loop',
        originLabel: `Task loop · ${this.state.goalTitle || 'goal'}`,
        autoApprove: Boolean(this.state.config?.autoApproveTools),
        alwaysAllowed: this.alwaysAllowed,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'delta') this.appendOutput(event.text)
          if (event.type === 'notice') {
            this.log(event.level, event.message)
          }
          if (event.type === 'error') {
            this.log('error', event.message)
          }
        },
        title,
        planService: this.plan,
        gitService: this.git,
        providerService: this.providers,
        defaultReviewer: () => this.settings.defaultReviewer,
        defaultReviewerModel: () => this.settings.defaultReviewerModel,
        claudeApiKey: this.settings.getClaudeApiKey(),
        executablePath: this.settings.claudeExecutablePath
      })
      return {
        text: result.text,
        sessionId: result.sdkSessionId,
        error: timedOut
          ? `Implementer timed out after ${Math.round(TASK_TIMEOUT_MS / 60_000)} minutes.`
          : result.error,
        aborted: result.aborted || signal.aborted
      }
    } catch (error) {
      return {
        text: '',
        sessionId: null,
        error: timedOut
          ? `Implementer timed out after ${Math.round(TASK_TIMEOUT_MS / 60_000)} minutes.`
          : (error as Error).message,
        aborted: controller.signal.aborted
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async implementPrompt(goal: GoalDetail, task: TaskRef): Promise<string> {
    return [
      'You are the implementation agent in an autonomous ProHarness task loop.',
      `Goal: ${goal.title} (${goal.id})`,
      `Phase: ${task.phaseTitle}`,
      `Task: ${task.taskTitle} (id ${task.taskId})`,
      '',
      `Read goals/${goal.id}/DESIGN.md and goals/${goal.id}/PLAN.md before editing.`,
      'Implement this task and only this task. Keep the change set tightly scoped.',
      'Run the most relevant checks you can (typecheck, tests, build) and fix failures you introduce.',
      'Do not commit, do not check off the task, and do not start the next task. The loop handles both.',
      'If a step is impossible or needs a secret, explain that clearly in your final response instead of faking the result.',
      'When finished, give a short summary of what changed and what you verified.'
    ].join('\n')
  }

  private async revisionPrompt(goal: GoalDetail, task: TaskRef, reviewNotes: string): Promise<string> {
    return [
      'An independent reviewer examined your working-tree implementation and requested changes.',
      `Goal: ${goal.title} (${goal.id})`,
      `Task: ${task.taskTitle} (id ${task.taskId})`,
      '',
      'Reviewer findings:',
      reviewNotes,
      '',
      'Fix the findings in the working tree. Keep the original task scope.',
      'Do not commit and do not check off the task. Re-run relevant verification after fixing.',
      'Finish with a short list of what you changed in response to the review.'
    ].join('\n')
  }

  private async review(
    goal: GoalDetail,
    task: TaskRef,
    config: LoopConfig,
    signal: AbortSignal
  ): Promise<{ verdict: 'APPROVE' | 'REQUEST_CHANGES'; notes: string; summary: string }> {
    const { summary, diff, truncated } = await this.git.reviewDiff()
    if (!summary.files.length) {
      throw new Error('The implementer produced no working-tree changes.')
    }
    const prompt = buildReviewPrompt({
      goal: { id: goal.id, title: goal.title },
      task,
      design: goal.design,
      diff,
      diffTruncated: truncated
    })
    this.log(
      'info',
      `Reviewing ${summary.files.length} changed file(s) with ${this.reviewerLabel(config)}.`
    )
    const result = await this.providers.complete(
      {
        provider: config.reviewerProvider,
        model: config.reviewerModel,
        system:
          'You are a precise, skeptical senior code reviewer. Follow the required output format exactly. Never approve an empty or failing diff.',
        prompt,
        maxTokens: 8_000
      },
      signal
    )
    const parsed = parseReview(result.text)
    this.state.review = {
      verdict: parsed.verdict,
      notes: parsed.notes,
      provider: config.reviewerProvider,
      model: config.reviewerModel
    }
    this.log(
      parsed.verdict === 'APPROVE' ? 'success' : 'warn',
      `Reviewer verdict: ${parsed.verdict}${parsed.summary ? ` — ${parsed.summary}` : ''}`
    )
    if (parsed.parseWarning) this.log('warn', parsed.parseWarning)
    return { verdict: parsed.verdict, notes: parsed.notes, summary: parsed.summary }
  }

  private commitMessage(goal: GoalDetail, task: TaskRef, config: LoopConfig): string {
    const subject = `proharness(${goal.id}): ${task.taskId} ${task.taskTitle}`.slice(0, 100)
    return [
      subject,
      '',
      `Goal: ${goal.title}`,
      `Phase: ${task.phaseTitle}`,
      `Task: ${task.taskTitle}`,
      `Reviewed-by: ${PROVIDER_LABELS[config.reviewerProvider]}/${config.reviewerModel} (APPROVE)`,
      '',
      'Committed by the ProHarness autonomous task loop.'
    ].join('\n')
  }

  private async executeTask(
    goal: GoalDetail,
    task: TaskRef,
    config: LoopConfig,
    record: LoopTaskRecord,
    signal: AbortSignal
  ): Promise<void> {
    this.state.currentTask = task
    this.state.review = null
    this.setStep('implementing')
    this.log('info', `Implementing ${task.taskId}: ${task.taskTitle}`)

    let agent = await this.runAgent(await this.implementPrompt(goal, task), null, signal, `Task ${task.taskId}`)
    if (signal.aborted) throw new Error('aborted')
    if (agent.aborted) throw new Error('The implementer was interrupted.')
    if (agent.error) throw new Error(agent.error)
    record.attempts = 1

    await this.checkpoint(signal)
    let review = await this.review(goal, task, config, signal)
    let rounds = 0

    while (review.verdict === 'REQUEST_CHANGES') {
      if (rounds >= config.maxReviewRounds) {
        throw new Error(
          `Reviewer requested changes after ${rounds} revision(s). The working tree was left intact and nothing was committed.`
        )
      }
      rounds += 1
      record.status = 'revising'
      record.reviewVerdict = 'REQUEST_CHANGES'
      record.reviewNotes = review.notes
      record.attempts += 1
      this.setStep('revising')
      this.log('warn', `Sending reviewer findings back for revision (round ${rounds}/${config.maxReviewRounds}).`)
      const revision = await this.runAgent(
        await this.revisionPrompt(goal, task, review.notes),
        agent.sessionId,
        signal,
        `Task ${task.taskId} revision ${rounds}`
      )
      if (signal.aborted || revision.aborted) throw new Error('aborted')
      if (revision.error) throw new Error(revision.error)
      agent = revision
      await this.checkpoint(signal)
      review = await this.review(goal, task, config, signal)
    }

    record.reviewVerdict = 'APPROVE'
    record.reviewNotes = review.notes
    record.status = 'reviewing'
    await this.checkpoint(signal)

    if (config.commit) {
      this.setStep('committing')
      const freshGoal = this.plan.readGoal(goal.id)
      const commit = await this.git.commitAll(this.commitMessage(freshGoal, task, config))
      record.commitHash = commit.hash
      this.log('success', `Committed implementation as ${commit.hash}.`)
    }

    this.setStep('marking')
    this.plan.setTaskChecked(goal.id, task.taskId, true)
    this.log('info', `Checked off ${task.taskId} in ${goal.id}/PLAN.md.`)
    if (config.commit) {
      try {
        const planCommit = await this.git.commitAll(
          `chore(plan): complete ${task.taskId} in ${goal.id}`
        )
        this.log('info', `Committed checklist update as ${planCommit.hash}.`)
      } catch (error) {
        throw new Error(
          `Task was checked off but the checklist commit failed: ${(error as Error).message}. Working tree may contain the uncommitted plan update.`
        )
      }
    }

    record.status = 'committed'
    record.finishedAt = Date.now()
    this.state.queue = this.state.queue.filter((item) => item.taskId !== task.taskId)
    this.log('success', `Task ${task.taskId} complete.`)
    this.emitState()
  }

  private async checkpoint(signal: AbortSignal): Promise<void> {
    await this.waitWhilePaused(signal)
    if (this.state.status !== 'running') throw new Error('aborted')
  }

  private async run(config: LoopConfig): Promise<void> {
    this.active = true
    const signal = this.abortController!.signal
    try {
      while (true) {
        await this.checkpoint(signal)
        const committed = this.state.completed.filter((record) => record.status === 'committed').length
        if (committed >= config.maxTasks) {
          this.log('info', `Reached the run limit of ${config.maxTasks} task(s). Start a new run to continue.`)
          this.state.status = 'complete'
          this.state.currentStep = 'complete'
          break
        }

        const worktree = await this.git.summary()
        if (!worktree.clean) {
          throw new Error(
            `The working tree became dirty between tasks (${worktree.files.length} change(s)). The loop stopped before its commit could absorb unrelated work.`
          )
        }

        const goal = this.plan.readGoal(config.goalId)
        this.state.goalTitle = goal.title
        this.state.queue = openTasks(goal)
        const task = this.plan.nextTask(config.goalId)
        if (!task) {
          this.state.status = 'complete'
          this.state.currentStep = 'complete'
          this.state.currentTask = null
          this.log('success', 'Every task in this goal is complete.')
          break
        }

        const record = this.recordFor(task)
        this.state.completed.push(record)
        this.state.currentTask = task
        this.state.queue = this.state.queue.filter((item) => item.taskId !== task.taskId)
        this.emitState()
        try {
          await this.executeTask(goal, task, config, record, signal)
        } catch (error) {
          record.status = 'failed'
          record.error = (error as Error).message
          record.finishedAt = Date.now()
          if (this.state.status === 'stopping' || signal.aborted) {
            this.state.status = 'stopped'
            this.log('warn', 'Task loop stopped. Uncommitted work, if any, was left in the working tree.')
          } else {
            this.state.status = 'error'
            this.state.error = (error as Error).message
            this.state.currentStep = 'error'
            this.log('error', (error as Error).message)
          }
          break
        }

        if (config.pauseBetweenMs > 0) {
          this.state.currentStep = 'waiting'
          this.emitState()
          try {
            await delay(config.pauseBetweenMs, signal)
          } catch {
            break
          }
        }
      }
    } catch (error) {
      if (this.state.status === 'stopping' || signal.aborted) {
        this.state.status = 'stopped'
        this.log('warn', 'Task loop stopped.')
      } else {
        this.state.status = 'error'
        this.state.error = (error as Error).message
        this.state.currentStep = 'error'
        this.log('error', (error as Error).message)
      }
    } finally {
      if (this.state.status === 'running' || this.state.status === 'paused') {
        this.state.status = this.state.status === 'paused' ? 'paused' : 'complete'
      }
      if (this.state.status === 'complete' || this.state.status === 'stopped' || this.state.status === 'error') {
        this.state.finishedAt = Date.now()
        if (this.state.status !== 'error') this.state.currentTask = null
      }
      this.active = false
      this.abortController = null
      this.emitState()
    }
  }

  dispose(): void {
    this.abortController?.abort()
  }
}
