import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalMode, RecentSession, SessionCreateInput, SessionEvent, ThinkingLevel } from '@shared/types'
import { OmpAgent } from '../omp/agent'
import type { GitService } from './git'
import { createPlanTools, PLAN_SYSTEM_PROMPT, PLAN_TOOL_NAMES } from './host-tools'
import type { OmpService } from './omp'
import type { PlanService } from './plan'
import type { SettingsService } from './settings'
import type { UiBroker } from './ui-broker'

interface RuntimeSession {
  tabId: string
  title: string
  agent: OmpAgent
  starting: Promise<void>
}

const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/

/** Writes the omp config overlay that lets host plan tools run without a prompt. */
export function writeHostToolOverlay(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'omp-overlay.yml')
  const lines = ['tools:', '  approval:', ...PLAN_TOOL_NAMES.map((name) => `    ${name}: allow`), '']
  writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

/**
 * omp stores sessions under ~/.omp/agent/sessions/<key>/. Paths inside the home
 * folder become "-<relative path with - for />"; other paths "--<path>--".
 */
export function sessionDirFor(cwd: string, home = homedir()): string {
  const root = join(home, '.omp', 'agent', 'sessions')
  const clean = cwd.replace(/[\\/]+$/, '')
  if (clean === home) return join(root, '-')
  if (clean.startsWith(`${home}/`)) return join(root, `-${clean.slice(home.length + 1).replace(/[\\/]/g, '-')}`)
  return join(root, `--${clean.replace(/^[\\/]+/, '').replace(/[\\/]/g, '-')}--`)
}

/** Reads the cwd recorded in an omp session file header. */
export function sessionCwd(file: string): string | null {
  try {
    for (const line of readHead(file, 16 * 1024).split('\n')) {
      if (!line.includes('"type":"session"')) continue
      const entry = JSON.parse(line) as Record<string, unknown>
      return typeof entry.cwd === 'string' ? entry.cwd : null
    }
  } catch {
    // Unreadable or malformed.
  }
  return null
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readHead(file: string, bytes = 64 * 1024): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function listRecentSessions(cwd: string, limit = 25): RecentSession[] {
  const dir = sessionDirFor(cwd)
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  const items = files
    .map((name) => {
      const file = join(dir, name)
      try {
        return { file, mtime: statSync(file).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { file: string; mtime: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit * 2)

  const out: RecentSession[] = []
  for (const item of items) {
    let title = ''
    let model: string | null = null
    let firstUser = ''
    try {
      for (const line of readHead(item.file).split('\n')) {
        if (!line.trim()) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (entry.type === 'title' && typeof entry.title === 'string') title = entry.title.trim()
        if (entry.type === 'model_change' && typeof entry.model === 'string' && !model) model = entry.model
        const message = entry.message as Record<string, unknown> | undefined
        if (!firstUser && message?.role === 'user') {
          const content = message.content
          const text = Array.isArray(content)
            ? content.map((part) => ((part as Record<string, unknown>).type === 'text' ? String((part as Record<string, unknown>).text) : '')).join(' ')
            : String(content ?? '')
          firstUser = text.replace(/\s+/g, ' ').trim()
        }
      }
    } catch {
      continue
    }
    if (!title && !firstUser) continue
    out.push({ file: item.file, title: (title || firstUser).slice(0, 90), updatedAt: item.mtime, model })
    if (out.length >= limit) break
  }
  return out
}

export class SessionManager {
  private sessions = new Map<string, RuntimeSession>()
  private emit: (tabId: string, event: SessionEvent) => void = () => undefined
  private overlay: string

  constructor(
    private readonly settings: SettingsService,
    private readonly omp: OmpService,
    private readonly plan: PlanService,
    private readonly git: GitService,
    private readonly broker: UiBroker,
    dataDir: string
  ) {
    this.overlay = writeHostToolOverlay(dataDir)
  }

  setEmitter(emitter: (tabId: string, event: SessionEvent) => void): void {
    this.emit = emitter
  }

  get overlayPath(): string {
    return this.overlay
  }

  private get(tabId: string): RuntimeSession {
    const session = this.sessions.get(tabId)
    if (!session) throw new Error('This session is closed. Open a new tab.')
    return session
  }

  private async ready(tabId: string): Promise<OmpAgent> {
    const session = this.get(tabId)
    await session.starting
    if (!session.agent.alive) throw new Error('omp is not running for this tab. Close it and open a new one.')
    return session.agent
  }

  async create(input: SessionCreateInput): Promise<void> {
    if (!TAB_ID_RE.test(input.tabId)) throw new Error('Invalid session id.')
    if (this.sessions.has(input.tabId)) return
    const ompPath = await this.omp.binary()
    const env = await this.omp.env()
    const tabId = input.tabId
    const approval: ApprovalMode = input.approval || this.settings.chatApproval
    const model = input.model?.trim() || this.settings.chatModel || undefined
    const agent = new OmpAgent({
      ompPath,
      env,
      cwd: this.settings.workspacePath,
      model,
      thinking: input.thinking,
      approval,
      mode: 'rpc-ui',
      ephemeral: false,
      configOverlays: [this.overlay],
      appendSystemPrompt: PLAN_SYSTEM_PROMPT,
      hostTools: createPlanTools({ plan: this.plan, git: this.git, allowComplete: true }),
      broker: this.broker,
      origin: 'session',
      originId: tabId,
      originLabel: () => this.sessions.get(tabId)?.title || 'Session',
      onEvent: (event) => this.emit(tabId, event)
    })
    const session: RuntimeSession = { tabId, title: input.title || 'New session', agent, starting: Promise.resolve() }
    session.starting = (async () => {
      await agent.start()
      if (input.resumeFile) {
        await agent.switchSession(input.resumeFile)
      }
    })()
    this.sessions.set(tabId, session)
    try {
      await session.starting
    } catch (error) {
      this.emit(tabId, { type: 'status', status: 'error', detail: (error as Error).message })
      this.emit(tabId, { type: 'notice', level: 'error', message: (error as Error).message })
      throw error
    }
  }

  async send(tabId: string, text: string, behavior: 'steer' | 'followUp' = 'followUp'): Promise<void> {
    if (!text.trim()) throw new Error('Type a message before sending.')
    const agent = await this.ready(tabId)
    const session = this.get(tabId)
    if (session.title === 'New session') session.title = text.replace(/\s+/g, ' ').slice(0, 48)
    await agent.prompt(text, behavior)
  }

  async stop(tabId: string): Promise<void> {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.broker.cancelOrigin(tabId)
    await session.agent.abort()
  }

  async setModel(tabId: string, model: string): Promise<void> {
    await (await this.ready(tabId)).setModel(model)
  }

  async setThinking(tabId: string, level: ThinkingLevel): Promise<void> {
    await (await this.ready(tabId)).setThinking(level)
  }

  async newConversation(tabId: string): Promise<void> {
    await (await this.ready(tabId)).newSession()
  }

  async resume(tabId: string, file: string): Promise<void> {
    const cwd = sessionCwd(file)
    if (!cwd || realpathOr(cwd) !== realpathOr(this.settings.workspacePath)) {
      throw new Error('That session belongs to a different workspace.')
    }
    await (await this.ready(tabId)).switchSession(file)
  }

  async compact(tabId: string): Promise<void> {
    await (await this.ready(tabId)).compact()
  }

  async removeQueued(tabId: string, message: string, queue: 'steering' | 'followUp'): Promise<void> {
    await (await this.ready(tabId)).removeQueued(message, queue)
  }

  recent(): RecentSession[] {
    return listRecentSessions(this.settings.workspacePath)
  }

  rename(tabId: string, title: string): void {
    const session = this.sessions.get(tabId)
    if (session && title.trim()) session.title = title.trim().slice(0, 80)
  }

  async close(tabId: string): Promise<void> {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    this.broker.cancelOrigin(tabId)
    await session.agent.close()
  }

  async dispose(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((session) => session.agent.close()))
  }
}

export function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
