import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LoopConfig, LoopState } from '../src/shared/types'
import type { ClaudeService, RunTurnOptions, RunTurnResult } from '../src/main/services/claude'
import { GitService } from '../src/main/services/git'
import { PlanService } from '../src/main/services/plan'
import { ProviderService } from '../src/main/services/providers'
import type { SettingsService } from '../src/main/services/settings'
import { TaskLoopService } from '../src/main/services/task-loop'

let root = ''
let server: Server
let baseUrl = ''
let verdicts: string[] = []
let reviewerPrompts: string[] = []

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function sse(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    '',
    'data: [DONE]',
    ''
  ].join('\n')
}

/** Implementer stand-in: writes a file for the current task the way Claude would. */
class FakeClaude {
  calls: RunTurnOptions[] = []
  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    this.calls.push(options)
    const task = options.prompt.match(/id (\d+\.\d+)/)?.[1] || 'x'
    writeFileSync(join(root, `task-${task}.txt`), `${options.prompt.length}\n`, { flag: 'a' })
    options.onEvent({ type: 'delta', messageId: 'm', block: 'text', text: `did ${task}` })
    return { sdkSessionId: `session-${this.calls.length}`, text: `did ${task}`, meta: null, aborted: false, error: null }
  }
}

function settingsFor(): SettingsService {
  return {
    workspacePath: root,
    claudeModel: 'claude-test',
    claudeExecutablePath: '',
    defaultReviewer: 'deepseek',
    defaultReviewerModel: 'mock',
    getClaudeApiKey: () => undefined,
    getProviderApiKey: () => 'test-key',
    getProviderBaseUrl: () => baseUrl,
    getProviderModel: () => 'mock',
    providerIsConfigured: () => true
  } as unknown as SettingsService
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
  reviewerProvider: 'deepseek',
  reviewerModel: 'mock',
  autoApproveTools: true,
  maxTasks: 5,
  maxReviewRounds: 1,
  pauseBetweenMs: 0,
  commit: true,
  permissionMode: 'acceptEdits'
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'proharness-loop-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@proharness.local')
  git('config', 'user.name', 'ProHarness Test')
  mkdirSync(join(root, 'goals', 'demo'), { recursive: true })
  writeFileSync(join(root, 'goals', 'demo', 'DESIGN.md'), '# Demo\n\nDemo goal.\n')
  writeFileSync(
    join(root, 'goals', 'demo', 'PLAN.md'),
    '# Plan\n\n## Phase 1 — One\n\n- [ ] **1.1** First\n- [ ] **1.2** Second\n'
  )
  git('add', '-A')
  git('commit', '-qm', 'initial')

  verdicts = []
  reviewerPrompts = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      reviewerPrompts.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(verdicts.shift() || 'VERDICT: APPROVE\nSUMMARY: fine\nFINDINGS:\n- none'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function build(claude: FakeClaude): TaskLoopService {
  const settings = settingsFor()
  const plan = new PlanService(() => root)
  const gitService = new GitService(() => root)
  const providers = new ProviderService(settings)
  return new TaskLoopService(settings, plan, gitService, providers, claude as unknown as ClaudeService)
}

describe('TaskLoopService', () => {
  it('implements, reviews, commits, and checks off every task', async () => {
    const claude = new FakeClaude()
    const loop = build(claude)
    await loop.start(config)
    const state = await waitForEnd(loop)

    expect(state.status).toBe('complete')
    expect(state.completed.map((record) => record.status)).toEqual(['committed', 'committed'])
    const plan = readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')
    expect(plan).toContain('- [x] **1.1** First')
    expect(plan).toContain('- [x] **1.2** Second')
    expect(git('status', '--porcelain')).toBe('')
    const log = git('log', '--format=%s')
    expect(log).toContain('proharness(demo): 1.1 First')
    expect(log).toContain('chore(plan): complete 1.2 in demo')
    // The reviewer sees the real diff, and the implementer cannot check off its own task.
    expect(reviewerPrompts[0]).toContain('task-1.1.txt')
    expect(claude.calls[0].disallowedTools).toContain('mcp__proharness__plan_complete_task')
  })

  it('sends findings back for revision on the same session and then commits', async () => {
    verdicts = ['VERDICT: REQUEST_CHANGES\nSUMMARY: missing tests\nFINDINGS:\n- add tests']
    const claude = new FakeClaude()
    const loop = build(claude)
    await loop.start({ ...config, maxTasks: 1 })
    const state = await waitForEnd(loop)

    expect(state.status).toBe('complete')
    expect(claude.calls).toHaveLength(2)
    expect(claude.calls[1].prompt).toContain('add tests')
    expect(claude.calls[1].resume).toBe('session-1')
    expect(state.completed[0]).toMatchObject({ status: 'committed', attempts: 2 })
  })

  it('halts without committing when the reviewer keeps rejecting', async () => {
    verdicts = [
      'VERDICT: REQUEST_CHANGES\nSUMMARY: no\nFINDINGS:\n- a',
      'VERDICT: REQUEST_CHANGES\nSUMMARY: still no\nFINDINGS:\n- b'
    ]
    const loop = build(new FakeClaude())
    await loop.start({ ...config, maxTasks: 1 })
    const state = await waitForEnd(loop)

    expect(state.status).toBe('error')
    expect(state.error).toMatch(/nothing was committed/)
    expect(git('log', '--format=%s').trim().split('\n')).toEqual(['initial'])
    expect(git('status', '--porcelain')).toContain('task-1.1.txt')
    expect(readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')).toContain('- [ ] **1.1** First')
  })

  it('refuses to start on a dirty tree', async () => {
    writeFileSync(join(root, 'stray.txt'), 'x')
    await expect(build(new FakeClaude()).start(config)).rejects.toThrow(/uncommitted/)
  })
})
