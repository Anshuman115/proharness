import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LoopConfig, LoopState, SessionEvent } from '../src/shared/types'
import type { TurnResult } from '../src/main/omp/agent'
import { LocalHost } from '../src/main/host/local'
import { GitService } from '../src/main/services/git'
import { PlanService } from '../src/main/services/plan'
import { TaskLoopService, type LoopAgent, type LoopAgentFactory } from '../src/main/services/task-loop'

let root = ''

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

const ok = (text: string): TurnResult => ({ status: 'completed', error: null, text, costUsd: 0.01 })

class FakeFactory implements LoopAgentFactory {
  plan: PlanService | null = null
  implementerPrompts: string[] = []
  reviewerPrompts: string[] = []
  reviewerModels: string[] = []
  verdicts: string[] = []

  defaultModel(): string | null {
    return 'anthropic/claude-sonnet-5-5'
  }

  async implementer(options: { onEvent: (event: SessionEvent) => void }): Promise<LoopAgent> {
    return {
      start: async () => undefined,
      runTurn: async (text) => {
        this.implementerPrompts.push(text)
        const task = (await this.plan?.nextTask('demo'))?.taskId || 'x'
        writeFileSync(join(root, `task-${task}.txt`), `${this.implementerPrompts.length}\n`, { flag: 'a' })
        options.onEvent({ type: 'delta', messageId: 'm', index: 0, text: `did ${task}` })
        return ok(`did ${task}`)
      },
      close: async () => undefined
    }
  }

  async reviewer(options: { model: string }): Promise<LoopAgent> {
    this.reviewerModels.push(options.model)
    return {
      start: async () => undefined,
      runTurn: async (text) => {
        this.reviewerPrompts.push(text)
        return ok(this.verdicts.shift() || 'Looks right.\nVERDICT: APPROVE\nSUMMARY: fine\nFINDINGS:\n- none')
      },
      close: async () => undefined
    }
  }
}

function waitForEnd(loop: TaskLoopService): Promise<LoopState> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      const state = loop.getState()
      if (['complete', 'error', 'stopped'].includes(state.status)) resolve(state)
      else if (Date.now() - started > 10_000) reject(new Error(`loop stuck in ${state.status}`))
      else setTimeout(tick, 20)
    }
    tick()
  })
}

const config: LoopConfig = {
  goalId: 'demo',
  implementerModel: '',
  reviewerModel: 'openai-codex/gpt-6.1-sol',
  approval: 'yolo',
  maxTasks: 5,
  maxReviewRounds: 1,
  pauseBetweenMs: 0
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proharness-loop-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@proharness.local')
  git('config', 'user.name', 'ProHarness Test')
  writeFileSync(join(root, 'README.md'), '# demo\n')
  git('add', '-A')
  git('commit', '-qm', 'initial')
  // goals/ is local planning state: present on disk, never committed.
  mkdirSync(join(root, 'goals', 'demo'), { recursive: true })
  writeFileSync(join(root, 'goals', 'demo', 'DESIGN.md'), '# Demo\n\nDemo goal.\n')
  writeFileSync(join(root, 'goals', 'demo', 'PLAN.md'), '# Plan\n\n## Phase 1 — One\n\n- [ ] **1.1** First\n- [ ] **1.2** Second\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function build(factory: LoopAgentFactory): TaskLoopService {
  const host = new LocalHost()
  const plan = new PlanService(() => host, () => root)
  if (factory instanceof FakeFactory) factory.plan = plan
  return new TaskLoopService(plan, new GitService(() => host, () => root), factory)
}

describe('TaskLoopService', () => {
  it('implements, reviews, commits code only, and checks off every task locally', async () => {
    const factory = new FakeFactory()
    const loop = build(factory)
    await loop.start(config)
    const state = await waitForEnd(loop)

    expect(state.status).toBe('complete')
    expect(state.completed.map((record) => record.status)).toEqual(['committed', 'committed'])
    const plan = readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')
    expect(plan).toContain('- [x] **1.1** First')
    expect(plan).toContain('- [x] **1.2** Second')
    // One commit per task, none containing goals/.
    expect(git('log', '--format=%s').trim().split('\n')).toEqual(['1.2: Second', '1.1: First', 'initial'])
    expect(git('log', '--name-only', '--format=')).not.toContain('goals/')
    expect(git('ls-files')).not.toContain('goals/')
    expect(git('status', '--porcelain')).toBe('')
    // The reviewer sees the real diff and is a different model.
    expect(factory.reviewerPrompts[0]).toContain('task-1.1.txt')
    expect(factory.reviewerPrompts[0]).not.toContain('PLAN.md\n+')
    expect(factory.reviewerModels).toEqual(['openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6.1-sol'])
    expect(git('log', '-1', '--format=%B')).toContain('Reviewed-by: openai-codex/gpt-6.1-sol (APPROVE)')
    expect(state.costUsd).toBeGreaterThan(0)
  })

  it('sends findings back for revision and then commits', async () => {
    const factory = new FakeFactory()
    factory.verdicts = ['VERDICT: REQUEST_CHANGES\nSUMMARY: missing tests\nFINDINGS:\n- add tests']
    const loop = build(factory)
    await loop.start({ ...config, maxTasks: 1 })
    const state = await waitForEnd(loop)

    expect(state.status).toBe('complete')
    expect(factory.implementerPrompts).toHaveLength(2)
    expect(factory.implementerPrompts[1]).toContain('add tests')
    expect(state.completed[0]).toMatchObject({ status: 'committed', attempts: 2 })
  })

  it('halts without committing when the reviewer keeps rejecting', async () => {
    const factory = new FakeFactory()
    factory.verdicts = [
      'VERDICT: REQUEST_CHANGES\nSUMMARY: no\nFINDINGS:\n- a',
      'VERDICT: REQUEST_CHANGES\nSUMMARY: still no\nFINDINGS:\n- b'
    ]
    const loop = build(factory)
    await loop.start({ ...config, maxTasks: 1 })
    const state = await waitForEnd(loop)

    expect(state.status).toBe('error')
    expect(state.error).toMatch(/nothing was committed/)
    expect(git('log', '--format=%s').trim().split('\n')).toEqual(['initial'])
    expect(git('status', '--porcelain')).toContain('task-1.1.txt')
    expect(readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')).toContain('- [ ] **1.1** First')
  })

  it('refuses a dirty tree but ignores goals/ edits', async () => {
    writeFileSync(join(root, 'goals', 'demo', 'notes.md'), 'scratch')
    const factory = new FakeFactory()
    const loop = build(factory)
    await loop.start({ ...config, maxTasks: 1 })
    expect((await waitForEnd(loop)).status).toBe('complete')

    writeFileSync(join(root, 'stray.txt'), 'x')
    await expect(build(new FakeFactory()).start(config)).rejects.toThrow(/uncommitted/)
  })

  it('refuses to review with the implementer model', async () => {
    await expect(
      build(new FakeFactory()).start({
        ...config,
        implementerModel: 'anthropic/claude-sonnet-5-5',
        reviewerModel: 'commandcode/claude-sonnet-5-5'
      })
    ).rejects.toThrow(/different model/)
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type FakeMode = 'ok' | 'wait-for-abort' | 'error'

/** A fake that decides its task from its own turn counter, never from the prompt text. */
class ControlledFactory implements LoopAgentFactory {
  turns = 0
  readonly turnStarted = deferred()
  readonly releaseFirstTurn = deferred()

  constructor(
    private readonly mode: FakeMode = 'ok',
    private readonly gateFirstTurn = false
  ) {}

  defaultModel(): string | null {
    return 'anthropic/claude-sonnet-5-5'
  }

  async implementer(): Promise<LoopAgent> {
    return {
      start: async () => undefined,
      runTurn: async (_text, signal) => {
        this.turns += 1
        this.turnStarted.resolve()
        if (this.mode === 'error') return { status: 'error', error: 'boom', text: '', costUsd: 0 }
        if (this.mode === 'wait-for-abort') {
          return new Promise<TurnResult>((resolve) => {
            const finish = (): void => resolve({ status: 'aborted', error: null, text: '', costUsd: 0 })
            if (signal.aborted) finish()
            else signal.addEventListener('abort', finish, { once: true })
          })
        }
        if (this.gateFirstTurn && this.turns === 1) await this.releaseFirstTurn.promise
        writeFileSync(join(root, `change-${this.turns}.txt`), `${this.turns}\n`)
        return ok(`turn ${this.turns}`)
      },
      close: async () => undefined
    }
  }

  async reviewer(): Promise<LoopAgent> {
    return {
      start: async () => undefined,
      runTurn: async () => ok('Looks right.\nVERDICT: APPROVE\nSUMMARY: fine\nFINDINGS:\n- none'),
      close: async () => undefined
    }
  }
}

function waitForStep(loop: TaskLoopService, step: LoopState['currentStep']): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (loop.getState().currentStep === step) resolve()
      else if (Date.now() - started > 10_000) reject(new Error(`loop never reached ${step}`))
      else setTimeout(tick, 10)
    }
    tick()
  })
}

function planText(): string {
  return readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')
}

describe('TaskLoopService stop, pause and failure paths', () => {
  it('stops during an implementer turn without committing or checking off', async () => {
    const factory = new ControlledFactory('wait-for-abort')
    const loop = build(factory)
    await loop.start({ ...config, maxTasks: 1 })
    await factory.turnStarted.promise
    await waitForStep(loop, 'implementing')

    await loop.stop()
    const state = await waitForEnd(loop)

    expect(state.status).toBe('stopped')
    expect(git('log', '--format=%s').trim()).toBe('initial')
    expect(planText()).toContain('- [ ] **1.1** First')
  })

  it('pauses while implementing and resumes to completion', async () => {
    const factory = new ControlledFactory('ok', true)
    const loop = build(factory)
    await loop.start({ ...config, maxTasks: 2, pauseBetweenMs: 0 })
    await factory.turnStarted.promise
    await waitForStep(loop, 'implementing')

    await loop.pause()
    expect(loop.getState().status).toBe('paused')
    factory.releaseFirstTurn.resolve()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(loop.getState().status).toBe('paused')
    expect(git('log', '--format=%s').trim()).toBe('initial')

    await loop.resume()
    const state = await waitForEnd(loop)
    expect(state.status, state.error ?? undefined).toBe('complete')
    expect(state.completed.map((record) => record.status)).toEqual(['committed', 'committed'])
    expect(planText()).toContain('- [x] **1.1** First')
    expect(planText()).toContain('- [x] **1.2** Second')
  })

  it('reports an implementer error and commits nothing', async () => {
    const factory = new ControlledFactory('error')
    const loop = build(factory)
    await loop.start({ ...config, maxTasks: 1 })
    const state = await waitForEnd(loop)

    expect(state.status).toBe('error')
    expect(state.error).toContain('boom')
    expect(git('log', '--format=%s').trim()).toBe('initial')
    expect(planText()).toContain('- [ ] **1.1** First')
  })

  it('refuses to start while a loop is active', async () => {
    const factory = new ControlledFactory('ok', true)
    const loop = build(factory)
    await loop.start(config)
    await factory.turnStarted.promise

    await expect(loop.start(config)).rejects.toThrow(/already active/)

    await loop.stop()
    factory.releaseFirstTurn.resolve()
    expect((await waitForEnd(loop)).status).toBe('stopped')
  })

  it('rejects a goal with no open tasks', async () => {
    writeFileSync(join(root, 'goals', 'demo', 'PLAN.md'), '# Plan\n\n## Phase 1 — One\n\n- [x] **1.1** First\n')
    await expect(build(new ControlledFactory()).start(config)).rejects.toThrow(/no open tasks/)
  })
})
