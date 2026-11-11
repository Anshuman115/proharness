import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SESSION_TITLE, titleFromText } from '@shared/defaults'
import type { RecentSession, SessionCreateInput, SessionEvent, ThinkingLevel } from '@shared/types'
import type { WorkspaceHost } from '../host/host'
import type { OmpAgent } from '../omp/agent'
import type { AgentFactory } from './agents'
import type { SettingsService } from './settings'
import type { UiBroker } from './ui-broker'

interface RuntimeSession {
  tabId: string
  title: string
  agent: OmpAgent
  starting: Promise<void>
}

const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/

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
async function sessionCwd(host: WorkspaceHost, file: string): Promise<string | null> {
  let head: string
  try {
    head = await readHead(host, file, 16 * 1024)
  } catch {
    return null
  }
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"session"')) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      return typeof entry.cwd === 'string' ? entry.cwd : null
    } catch {
      // Unreadable or malformed line.
    }
  }
  return null
}

async function realpathOr(host: WorkspaceHost, path: string): Promise<string> {
  try {
    return await host.realpath(path)
  } catch {
    return path
  }
}

async function readHead(host: WorkspaceHost, file: string, bytes: number): Promise<string> {
  return (await host.readFile(file, bytes)).toString('utf8')
}

async function listRecentSessions(host: WorkspaceHost, cwd: string, limit = 25): Promise<RecentSession[]> {
  const home = await host.home()
  const dir = sessionDirFor(cwd, home)
  if (!(await host.stat(dir))) return []
  const entries = await host.readdir(dir)
  const items: Array<{ file: string; mtime: number }> = []
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue
    const file = host.path.join(dir, entry.name)
    const info = await host.stat(file).catch(() => null)
    if (info) items.push({ file, mtime: info.mtimeMs })
  }
  items.sort((a, b) => b.mtime - a.mtime)
  const recent = items.slice(0, limit * 2)

  const out: RecentSession[] = []
  for (const item of recent) {
    let title = ''
    let model: string | null = null
    let firstUser = ''
    let head: string
    try {
      head = await readHead(host, item.file, 64 * 1024)
    } catch {
      continue
    }
    for (const line of head.split('\n')) {
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
          ? content
              .map((part) =>
                (part as Record<string, unknown>).type === 'text' ? String((part as Record<string, unknown>).text) : ''
              )
              .join(' ')
          : String(content ?? '')
        firstUser = text.replace(/\s+/g, ' ').trim()
      }
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
  private generation = 0
  private pending = new Map<string, { generation: number; cancelled: boolean }>()

  constructor(
    private readonly settings: SettingsService,
    private readonly agents: Pick<AgentFactory, 'chat'>,
    private readonly broker: UiBroker,
    private readonly host: () => WorkspaceHost
  ) {}

  setEmitter(emitter: (tabId: string, event: SessionEvent) => void): void {
    this.emit = emitter
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
    const tabId = input.tabId
    const previous = this.pending.get(tabId)
    if (previous) previous.cancelled = true
    const reservation = { generation: this.generation, cancelled: false }
    this.pending.set(tabId, reservation)
    try {
      const agent = await this.agents.chat({
        tabId,
        model: input.model,
        originLabel: () => this.sessions.get(tabId)?.title || 'Session',
        onEvent: (event) => this.emit(tabId, event)
      })
      if (reservation.generation !== this.generation) {
        await agent.close()
        throw new Error('The workspace changed while the session was opening.')
      }
      if (reservation.cancelled) {
        await agent.close()
        throw new Error('Session start was cancelled.')
      }
      if (this.sessions.has(tabId)) {
        await agent.close()
        return
      }
      const session: RuntimeSession = { tabId, title: input.title || DEFAULT_SESSION_TITLE, agent, starting: Promise.resolve() }
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
    } finally {
      if (this.pending.get(tabId) === reservation) this.pending.delete(tabId)
    }
  }

  async send(tabId: string, text: string, behavior: 'steer' | 'followUp' = 'followUp'): Promise<void> {
    if (!text.trim()) throw new Error('Type a message before sending.')
    const agent = await this.ready(tabId)
    const session = this.get(tabId)
    if (session.title === DEFAULT_SESSION_TITLE) session.title = titleFromText(text)
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
    const host = this.host()
    const cwd = await sessionCwd(host, file)
    if (!cwd || (await realpathOr(host, cwd)) !== (await realpathOr(host, this.settings.workspacePath))) {
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

  recent(): Promise<RecentSession[]> {
    return listRecentSessions(this.host(), this.settings.workspacePath)
  }

  async close(tabId: string): Promise<void> {
    const pending = this.pending.get(tabId)
    if (pending) {
      pending.cancelled = true
      this.pending.delete(tabId)
    }
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    this.broker.cancelOrigin(tabId)
    await session.agent.close()
  }

  async dispose(): Promise<void> {
    this.generation += 1
    for (const pending of this.pending.values()) pending.cancelled = true
    this.pending.clear()
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((session) => session.agent.close()))
  }
}
