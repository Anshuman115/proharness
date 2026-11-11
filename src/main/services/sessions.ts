import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import type { ApprovalMode, RecentSession, SessionCreateInput, SessionEvent, ThinkingLevel } from '@shared/types'
import type { DirEntry, WorkspaceHost } from '../host/host'
import type { SshHost } from '../host/ssh'
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

function overlayYaml(): string {
  return ['tools:', '  approval:', ...PLAN_TOOL_NAMES.map((name) => `    ${name}: allow`), ''].join('\n')
}

/** Writes the omp config overlay that lets host plan tools run without a prompt. */
export function writeHostToolOverlay(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'omp-overlay.yml')
  writeFileSync(file, overlayYaml(), 'utf8')
  return file
}

const remoteOverlays = new Map<string, string>()

/**
 * Returns the overlay path omp should read on `host`. SSH hosts get the same
 * YAML written to ~/.cache/proharness; the local path is reused as-is.
 */
export async function ensureOverlay(host: WorkspaceHost, localPath: string): Promise<string> {
  if (host.kind === 'local') return localPath
  const cached = remoteOverlays.get(host.id)
  if (cached) return cached
  const home = await (host as SshHost).home()
  const file = posix.join(home, '.cache', 'proharness', 'omp-overlay.yml')
  await host.writeText(file, overlayYaml())
  remoteOverlays.set(host.id, file)
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
  if (host.kind === 'local') {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const read = readSync(fd, buffer, 0, bytes, 0)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  }
  const result = await host.exec('head', ['-c', String(bytes), file])
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not read ${file}.`)
  return result.stdout
}

async function listRecentSessions(host: WorkspaceHost, cwd: string, limit = 25): Promise<RecentSession[]> {
  const home = host.kind === 'ssh' ? await (host as SshHost).home() : homedir()
  const dir = sessionDirFor(cwd, home)
  let entries: DirEntry[]
  try {
    entries = await host.readdir(dir)
  } catch {
    return []
  }
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
  private readonly localOverlay: string

  constructor(
    private readonly settings: SettingsService,
    private readonly omp: OmpService,
    private readonly plan: PlanService,
    private readonly git: GitService,
    private readonly broker: UiBroker,
    dataDir: string,
    private readonly host: () => WorkspaceHost
  ) {
    this.localOverlay = writeHostToolOverlay(dataDir)
  }

  setEmitter(emitter: (tabId: string, event: SessionEvent) => void): void {
    this.emit = emitter
  }

  /** The overlay path omp reads on `host`; written on first use for SSH hosts. */
  overlayFor(host: WorkspaceHost): Promise<string> {
    return ensureOverlay(host, this.localOverlay)
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
    const host = this.host()
    const ompPath = await this.omp.binary(host)
    const env = host.kind === 'local' ? await this.omp.env() : {}
    const tabId = input.tabId
    const approval: ApprovalMode = input.approval || this.settings.chatApproval
    const model = input.model?.trim() || this.settings.chatModel || undefined
    const agent = new OmpAgent({
      ompPath,
      env,
      host,
      cwd: this.settings.workspacePath,
      model,
      thinking: input.thinking,
      approval,
      mode: 'rpc-ui',
      ephemeral: false,
      configOverlays: [await this.overlayFor(host)],
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
