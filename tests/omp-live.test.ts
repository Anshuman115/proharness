import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../src/shared/types'
import { OmpAgent } from '../src/main/omp/agent'
import { findOmp, shellEnv } from '../src/main/omp/env'
import { UiBroker } from '../src/main/services/ui-broker'

/**
 * Talks to the real omp binary and a real model. Opt in with
 * PROHARNESS_LIVE=1 (optionally PROHARNESS_LIVE_MODEL=provider/id).
 */
const live = process.env.PROHARNESS_LIVE === '1'
const model = process.env.PROHARNESS_LIVE_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash'

describe.skipIf(!live)('omp live', () => {
  it('streams a turn, serves a host tool, and routes an approval', async () => {
    const env = await shellEnv()
    const omp = findOmp('', env)
    expect(omp).toBeTruthy()
    const cwd = mkdtempSync(join(tmpdir(), 'proharness-live-'))
    execFileSync('git', ['init', '-q'], { cwd })
    const overlay = join(cwd, 'overlay.yml')
    writeFileSync(overlay, 'tools:\n  approval:\n    echo_plan: allow\n')
    const broker = new UiBroker()
    const approvals: string[] = []
    broker.setEmitters(
      (request) => {
        approvals.push(request.approval?.tool || request.title)
        broker.respond({ requestId: request.id, value: request.options[0] })
      },
      () => undefined
    )
    const events: SessionEvent[] = []
    let hostCalls = 0
    const agent = new OmpAgent({
      ompPath: omp!,
      env,
      cwd,
      model,
      approval: 'always-ask',
      mode: 'rpc',
      ephemeral: true,
      tools: ['read', 'bash'],
      noExtensions: true,
      configOverlays: [overlay],
      hostTools: [
        {
          name: 'echo_plan',
          label: 'Echo plan',
          description: 'Returns the next plan task.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          run: async () => {
            hostCalls += 1
            return 'Task 1.1: create hello.txt'
          }
        }
      ],
      broker,
      origin: 'session',
      originId: 'live',
      originLabel: () => 'live',
      onEvent: (event) => events.push(event)
    })
    try {
      await agent.start()
      const result = await agent.runTurn(
        'Call the echo_plan tool. Then use bash to run `echo hi > hello.txt && cat hello.txt`. Reply with the single word DONE.',
        new AbortController().signal
      )
      expect(result.status).toBe('completed')
      expect(hostCalls).toBe(1)
      expect(approvals).toContain('bash')
      expect(events.some((event) => event.type === 'delta')).toBe(true)
      expect(events.some((event) => event.type === 'tool' && event.status === 'done')).toBe(true)
      expect(result.text).toMatch(/DONE/i)
      expect(result.costUsd).toBeGreaterThanOrEqual(0)
    } finally {
      await agent.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 180_000)
})
