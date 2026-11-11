import { describe, expect, it, vi } from 'vitest'
import type { GoalDetail, LoopConfig } from '../src/shared/types'
import type { LoopAgent, LoopAgentFactory } from '../src/main/services/task-loop'
import { TaskLoopService } from '../src/main/services/task-loop'
import type { GitService } from '../src/main/services/git'
import type { PlanService } from '../src/main/services/plan'
import { WorkspaceGate } from '../src/main/services/workspace-gate'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

const config: LoopConfig = {
  goalId: 'demo',
  implementerModel: 'vendor/implementer',
  reviewerModel: 'vendor/reviewer',
  approval: 'yolo',
  maxTasks: 1,
  maxReviewRounds: 1,
  pauseBetweenMs: 0
}

const goal = {
  id: 'demo',
  title: 'Demo',
  designPath: '/work/goals/demo/DESIGN.md',
  planPath: '/work/goals/demo/PLAN.md',
  status: 'draft',
  phaseCount: 1,
  taskCount: 1,
  openCount: 1,
  progress: 0,
  updatedAt: 0,
  design: '',
  plan: '',
  phases: []
} as unknown as GoalDetail

function build(overrides: { plan?: Partial<PlanService>; git?: Partial<GitService>; agents?: Partial<LoopAgentFactory> } = {}) {
  const plan = {
    readGoal: vi.fn(async () => goal),
    nextTask: vi.fn(async () => null),
    ...overrides.plan
  } as unknown as PlanService
  const git = {
    summary: vi.fn(async () => ({ isRepo: true, clean: true, files: [], branch: 'main' })),
    excludeGoals: vi.fn(async () => ({ excluded: true, tracked: false })),
    ...overrides.git
  } as unknown as GitService
  const agents = {
    defaultModel: () => 'vendor/implementer',
    implementer: vi.fn(),
    reviewer: vi.fn(),
    ...overrides.agents
  } as unknown as LoopAgentFactory
  const gate = new WorkspaceGate()
  return { loop: new TaskLoopService(plan, git, agents, gate), gate, plan, git, agents }
}

describe('TaskLoopService start and drain', () => {
  it('rejects a start that loses its gate token during preflight', async () => {
    const readGoal = deferred<GoalDetail>()
    const { loop, gate, git, agents } = build({ plan: { readGoal: vi.fn(() => readGoal.promise) } })
    const starting = loop.start(config)
    const draining = loop.drain()
    gate.begin()
    try {
      readGoal.resolve(goal)
      await expect(starting).rejects.toThrow(/workspace is changing/)
      await draining
      expect(git.summary).not.toHaveBeenCalled()
      expect(agents.implementer).not.toHaveBeenCalled()
    } finally {
      gate.end()
    }
  })

  it('refuses a second start while the first is still starting', async () => {
    const readGoal = deferred<GoalDetail>()
    const { loop } = build({ plan: { readGoal: vi.fn(() => readGoal.promise) } })
    const first = loop.start(config)
    await expect(loop.start(config)).rejects.toThrow(/starting or active/)
    readGoal.resolve(goal)
    await first
  })


  it('closes a starting implementer when stopped and drain resolves', async () => {
    const closeGate = deferred<void>()
    let rejectStart!: (error: Error) => void
    const implementer = {
      start: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStart = reject
          })
      ),
      runTurn: vi.fn(),
      close: vi.fn(async () => {
        rejectStart?.(new Error('closed'))
        await closeGate.promise
      })
    } as unknown as LoopAgent
    const { loop } = build({ agents: { implementer: vi.fn(async () => implementer) } })
    await loop.start(config)
    await tick()
    const draining = loop.drain()
    let settled = false
    void draining.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    closeGate.resolve()
    await draining
    expect(implementer.close).toHaveBeenCalledTimes(1)
    expect(loop.getState().status).toBe('stopped')
  })

  it('drain waits for the run and the implementer close', async () => {
    const closeGate = deferred<void>()
    const implementer = {
      start: vi.fn(async () => undefined),
      runTurn: vi.fn(),
      close: vi.fn(async () => {
        await closeGate.promise
      })
    } as unknown as LoopAgent
    const { loop } = build({ agents: { implementer: vi.fn(async () => implementer) } })
    await loop.start(config)
    await tick()
    const draining = loop.drain()
    await tick()
    let settled = false
    void draining.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    closeGate.resolve()
    await draining
    expect(implementer.close).toHaveBeenCalledTimes(1)
  })
})
