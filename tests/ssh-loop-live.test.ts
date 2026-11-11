import { describe, expect, it } from 'vitest'
import type { LoopState } from '../src/shared/types'
import { HostRegistry } from '../src/main/host/registry'
import type { SshHost } from '../src/main/host/ssh'
import { AgentFactory } from '../src/main/services/agents'
import { GitService } from '../src/main/services/git'
import { OmpService } from '../src/main/services/omp'
import { PlanService } from '../src/main/services/plan'
import type { SettingsService } from '../src/main/services/settings'
import { TaskLoopService } from '../src/main/services/task-loop'
import { UiBroker } from '../src/main/services/ui-broker'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Runs a one-task loop on an SSH host. Opt in with PROHARNESS_SSH_HOST=<alias>. */
const hostId = process.env.PROHARNESS_SSH_HOST || ''

describe.skipIf(!hostId)('ssh loop live', () => {
  it('implements, reviews and commits on the remote host', async () => {
    const registry = new HostRegistry()
    const host = (await registry.connect(hostId)) as SshHost
    const root = `${await host.home()}/.cache/proharness-loop-${Date.now()}`
    await host.run(`mkdir -p ${root} && cd ${root} && git init -q -b main && git config user.email t@t && git config user.name t && echo '# demo' > README.md && git add -A && git commit -qm init`)
    await host.writeText(`${root}/goals/demo/DESIGN.md`, '# Demo\n\nTiny Python utils.\n')
    await host.writeText(
      `${root}/goals/demo/PLAN.md`,
      '# Plan\n\n## Phase 1 — Utils\n\n- [ ] **1.1** Create `slug.py` with `slugify(text: str) -> str` that lowercases, trims, and joins alphanumeric words with single hyphens.\n'
    )
    const settings = { workspacePath: root } as unknown as SettingsService
    const local = mkdtempSync(join(tmpdir(), 'ph-ssh-loop-'))
    const omp = new OmpService(() => '', () => root, join(local, 'omp-status.json'), () => host)
    const plan = new PlanService(() => host, () => root)
    const git = new GitService(() => host, () => root)
    const broker = new UiBroker()
    broker.setEmitters((request) => broker.respond({ requestId: request.id, value: request.options[0] ?? '' }), () => undefined)
    const agents = new AgentFactory(settings, omp, plan, git, broker, () => host)
    const loop = new TaskLoopService(plan, git, agents)
    const log: string[] = []
    loop.setEmitter((event) => {
      if (event.type === 'log') log.push(`${event.entry.level}: ${event.entry.message}`)
    })
    try {
      await loop.start({
        goalId: 'demo',
        implementerModel: 'commandcode/deepseek/deepseek-v4.1-flash',
        reviewerModel: 'commandcode/claude-sonnet-5-5',
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
      const out = await host.run(`cd ${root} && git log --format=%s && git ls-files && python3 -c "from slug import slugify; print(slugify('  Hello, World!  '))"`)
      console.log(out.stdout)
      expect(out.stdout).toContain('1.1:')
      expect(out.stdout).not.toContain('goals/')
      expect(out.stdout).toContain('hello-world')
      expect(await host.readText(`${root}/goals/demo/PLAN.md`)).toContain('- [x] **1.1**')
    } finally {
      loop.dispose()
      await host.run(`rm -rf ${root}`)
      registry.dispose()
    }
  }, 10 * 60_000)
})
