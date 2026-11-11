import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LoopState } from '../src/shared/types'
import { LocalHost } from '../src/main/host/local'
import { AgentFactory } from '../src/main/services/agents'
import { GitService } from '../src/main/services/git'
import { OmpService } from '../src/main/services/omp'
import { PlanService } from '../src/main/services/plan'
import type { SettingsService } from '../src/main/services/settings'
import { TaskLoopService } from '../src/main/services/task-loop'
import { UiBroker } from '../src/main/services/ui-broker'

/**
 * Runs the real loop with real omp models on a one-task plan.
 * Opt in with PROHARNESS_LIVE_LOOP=1. Override models with
 * PROHARNESS_LIVE_IMPLEMENTER / PROHARNESS_LIVE_REVIEWER.
 */
const live = process.env.PROHARNESS_LIVE_LOOP === '1'
const implementer = process.env.PROHARNESS_LIVE_IMPLEMENTER || 'commandcode/deepseek/deepseek-v4.1-flash'
const reviewer = process.env.PROHARNESS_LIVE_REVIEWER || 'commandcode/claude-sonnet-5-5'

describe.skipIf(!live)('loop live', () => {
  it('implements, reviews and commits one task with real models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proharness-live-loop-'))
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'live@proharness.local')
    git('config', 'user.name', 'ProHarness Live')
    writeFileSync(join(root, 'README.md'), '# demo\n')
    git('add', '-A')
    git('commit', '-qm', 'initial')
    mkdirSync(join(root, 'goals', 'demo'), { recursive: true })
    writeFileSync(join(root, 'goals', 'demo', 'DESIGN.md'), '# Demo\n\nA tiny Node utility module.\n')
    writeFileSync(
      join(root, 'goals', 'demo', 'PLAN.md'),
      '# Plan\n\n## Phase 1 — Utils\n\n- [ ] **1.1** Create `slug.js` exporting `slugify(text)` that lowercases, trims, and joins words with single hyphens, dropping non-alphanumerics. Use CommonJS `module.exports`.\n'
    )

    const settings = { workspacePath: root } as unknown as SettingsService
    const host = new LocalHost()
    const omp = new OmpService(() => '', () => root, join(root, '.ph', 'omp-status.json'), () => host)
    const plan = new PlanService(() => host, () => root)
    const gitService = new GitService(() => host, () => root)
    git('config', 'core.excludesFile', '/dev/null')
    writeFileSync(join(root, '.git', 'info', 'exclude'), '/.ph/\n/.omp-status.json\n')
    const broker = new UiBroker()
    broker.setEmitters(
      (request) => broker.respond({ requestId: request.id, value: request.options[0] ?? '' }),
      () => undefined
    )
    const agents = new AgentFactory(settings, omp, plan, gitService, broker, () => host)
    const loop = new TaskLoopService(plan, gitService, agents)
    const log: string[] = []
    loop.setEmitter((event) => {
      if (event.type === 'log') log.push(`${event.entry.level}: ${event.entry.message}`)
    })

    try {
      await loop.start({
        goalId: 'demo',
        implementerModel: implementer,
        reviewerModel: reviewer,
        approval: 'yolo',
        maxTasks: 1,
        maxReviewRounds: 2,
        pauseBetweenMs: 0
      })
      const state = await new Promise<LoopState>((resolve, reject) => {
        const started = Date.now()
        const tick = (): void => {
          const current = loop.getState()
          if (['complete', 'error', 'stopped'].includes(current.status)) resolve(current)
          else if (Date.now() - started > 9 * 60_000) reject(new Error(`timed out in ${current.currentStep}`))
          else setTimeout(tick, 500)
        }
        tick()
      })
      console.log(log.join('\n'))
      expect(state.status, state.error || '').toBe('complete')
      expect(git('log', '--format=%s')).toContain('1.1:')
      expect(git('ls-files')).not.toContain('goals/')
      expect(readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')).toContain('- [x] **1.1**')
      const slugify = (await import(join(root, 'slug.js'))).default?.slugify ?? (await import(join(root, 'slug.js'))).slugify
      expect(slugify('  Hello, World!  ')).toBe('hello-world')
      expect(state.review?.verdict).toBe('APPROVE')
    } finally {
      loop.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, 10 * 60_000)
})
