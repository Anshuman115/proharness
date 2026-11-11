import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../src/shared/types'
import { OmpAgent } from '../src/main/omp/agent'
import { HostRegistry } from '../src/main/host/registry'
import type { SshHost } from '../src/main/host/ssh'
import { GitService } from '../src/main/services/git'
import { OmpService } from '../src/main/services/omp'
import { PlanService } from '../src/main/services/plan'
import { UiBroker } from '../src/main/services/ui-broker'

/**
 * Exercises an SSH workspace end to end. Opt in with PROHARNESS_SSH_HOST=<alias>
 * (optionally PROHARNESS_SSH_PATH and PROHARNESS_SSH_MODEL).
 */
const hostId = process.env.PROHARNESS_SSH_HOST || ''
const model = process.env.PROHARNESS_SSH_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash'

describe.skipIf(!hostId)('ssh workspace live', () => {
  it('reads git and plans, and runs an omp turn on the remote host', async () => {
    const registry = new HostRegistry()
    const host = (await registry.connect(hostId)) as SshHost
    const home = await host.home()
    const root = `${home}/.cache/proharness-live-${Date.now()}`
    try {
      await host.run(`mkdir -p ${root} && cd ${root} && git init -q -b main && git config user.email t@t && git config user.name t && echo hi > a.txt && git add -A && git commit -qm init`)
      const git = new GitService(() => host, () => root)
      const plan = new PlanService(() => host, () => root)
      await host.writeText(`${root}/b.txt`, 'new\n')
      const summary = await git.summary()
      expect(summary.isRepo).toBe(true)
      expect(summary.files.map((file) => file.path)).toEqual(['b.txt'])
      const goal = await plan.createGoal('Remote demo')
      expect((await plan.listGoals())[0].id).toBe(goal.id)
      await git.excludeGoals()
      expect((await git.summary()).files.map((file) => file.path)).toEqual(['b.txt'])

      const broker = new UiBroker()
      broker.setEmitters((request) => broker.respond({ requestId: request.id, value: request.options[0] ?? '' }), () => undefined)
      const events: SessionEvent[] = []
      let hostCalls = 0
      const omp = new OmpService(() => '', () => root, `${home}/.cache/proharness-live-status-${Date.now()}.json`, () => host)
      const agent = new OmpAgent({
        spawn: await omp.spawner(host),
        model,
        approval: 'yolo',
        mode: 'rpc',
        ephemeral: true,
        tools: ['read', 'bash'],
        noExtensions: true,
        hostTools: [
          {
            name: 'plan_next_task',
            label: 'Plan',
            description: 'Returns the next plan task.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            run: async () => {
              hostCalls += 1
              return 'Task 1.1: First task'
            }
          }
        ],
        broker,
        origin: 'session',
        originId: 'ssh-live',
        originLabel: () => 'ssh',
        onEvent: (event) => events.push(event)
      })
      try {
        await agent.start()
        const result = await agent.runTurn('Call plan_next_task. Then run `uname -m && pwd` with bash. Reply with the bash output only.', new AbortController().signal)
        expect(result.status, result.error || '').toBe('completed')
        expect(hostCalls).toBe(1)
        expect(result.text).toContain('aarch64')
        expect(result.text).toContain(root)
      } finally {
        await agent.close()
      }
    } finally {
      await host.run(`rm -rf ${root}`)
      registry.dispose()
    }
  }, 180_000)
})
