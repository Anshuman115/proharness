import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalHost } from '../src/main/host/local'
import type { HostTool } from '../src/main/omp/agent'
import { GitService } from '../src/main/services/git'
import { createPlanTools, PLAN_TOOL_NAMES } from '../src/main/services/host-tools'
import { PlanService } from '../src/main/services/plan'

let root = ''
let plan: PlanService
let git: GitService
const host = new LocalHost()
const signal = new AbortController().signal

function gitCmd(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function tools(allowComplete: boolean): HostTool[] {
  return createPlanTools({ plan, git, allowComplete })
}

function tool(name: string): HostTool {
  const found = tools(true).find((item) => item.name === name)
  if (!found) throw new Error(`Tool ${name} is not exposed.`)
  return found
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proharness-tools-'))
  gitCmd('init', '-q')
  gitCmd('config', 'user.email', 'test@proharness.local')
  gitCmd('config', 'user.name', 'ProHarness Test')
  writeFileSync(join(root, 'README.md'), '# demo\n')
  gitCmd('add', '-A')
  gitCmd('commit', '-qm', 'initial')
  mkdirSync(join(root, 'goals', 'demo'), { recursive: true })
  writeFileSync(join(root, 'goals', 'demo', 'DESIGN.md'), '# Demo\n\nDemo goal.\n')
  writeFileSync(join(root, 'goals', 'demo', 'PLAN.md'), '# Plan\n\n## Phase 1 — One\n\n- [ ] **1.1** First\n- [ ] **1.2** Second\n')
  plan = new PlanService(() => host, () => root)
  git = new GitService(() => host, () => root)
})

afterEach(() => {
  plan.dispose()
  git.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('createPlanTools', () => {
  it('exposes plan_complete_task only when the caller owns check-off', () => {
    const withComplete = tools(true).map((item) => item.name)
    const withoutComplete = tools(false).map((item) => item.name)

    expect(withComplete).toContain('plan_complete_task')
    expect(withoutComplete).not.toContain('plan_complete_task')
    for (const name of [...withComplete, ...withoutComplete]) {
      expect(PLAN_TOOL_NAMES).toContain(name)
    }
  })

  it('checks a task off on disk and reports the next one', async () => {
    const next = tool('plan_next_task')
    expect(await next.run({ goal: 'demo' }, signal)).toContain('Task id: 1.1')

    const result = await tool('plan_complete_task').run({ goal: 'demo', task_id: '1.1' }, signal)
    expect(result).toContain('Checked off 1.1 in demo')
    expect(result).toContain('Next: Second')
    expect(readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')).toContain('- [x] **1.1** First')
    expect(await next.run({ goal: 'demo' }, signal)).toContain('Task id: 1.2')
  })

  it('rejects a missing required argument', async () => {
    await expect(tool('plan_next_task').run({}, signal)).rejects.toThrow(/Missing required argument/)
    await expect(tool('plan_complete_task').run({ goal: 'demo' }, signal)).rejects.toThrow(/Missing required argument/)
  })

  it('says when there are no goals', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'proharness-tools-empty-'))
    const emptyPlan = new PlanService(() => host, () => empty)
    try {
      const list = createPlanTools({ plan: emptyPlan, git, allowComplete: false }).find((item) => item.name === 'plan_list')
      expect(list).toBeDefined()
      expect(await list!.run({}, signal)).toContain('No goals')
    } finally {
      emptyPlan.dispose()
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('reports a changed file in git_status', async () => {
    writeFileSync(join(root, 'README.md'), '# demo\nchanged\n')
    const output = await tool('git_status').run({}, signal)
    expect(output).toContain('README.md')
    expect(output).toContain('MODIFIED')
  })
})
