import type { GitSummary, GoalSummary, LoginShareStatus, PublicSettings, WorkspaceRef } from '@shared/types'
import type { WorkspaceHost } from '../host/host'
import type { SshHost } from '../host/ssh'
import { WorkspaceGate } from './workspace-gate'

export interface WorkspaceServiceDeps {
  settings: {
    readonly workspaceHost: string
    readonly workspacePath: string
    publicSettings(): PublicSettings
    setWorkspace(ref: WorkspaceRef): PublicSettings
    setShareLogins(host: string, enabled: boolean): PublicSettings
  }
  registry: { connect(id: string): Promise<WorkspaceHost> }
  omp: { refresh(): unknown }
  loginShare: {
    prelude(host: WorkspaceHost): Promise<string>
    detach(host: SshHost): Promise<void>
    status(hostId: string): LoginShareStatus
  }
  loop: { drain(): Promise<void> }
  consult: { dispose(): Promise<void> }
  broker: { cancelAll(): void }
  sessions: { dispose(): Promise<void> }
  terminal: { dispose(): void }
  plan: { resetWatching(): void; listGoals(): Promise<GoalSummary[]> }
  git: { resetWatching(): void; summary(): Promise<GitSummary> }
  gate: WorkspaceGate
  onGoals(goals: GoalSummary[]): void
  onGit(summary: GitSummary): void
}

/** Expands `~` and relative paths against the host's home directory. */
export async function expandPath(host: Pick<WorkspaceHost, 'home' | 'path'>, input: string): Promise<string> {
  const home = await host.home()
  const path = input.trim()
  if (!path) return home
  if (path === '~') return home
  if (path.startsWith('~/')) return host.path.join(home, path.slice(2))
  return host.path.isAbsolute(path) ? path : host.path.join(home, path)
}

/**
 * Owns workspace transitions: validation, the one agent teardown, the settings
 * mutation, watcher resets and the snapshot pushes. Transitions are serialized;
 * the gate blocks new sessions, terminals, consults and loop runs while one is
 * in flight.
 */
export class WorkspaceService {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: WorkspaceServiceDeps) {}

  open(ref: WorkspaceRef): Promise<PublicSettings> {
    return this.enqueue(() => this.transition(ref))
  }

  restartAgents(): Promise<void> {
    return this.enqueue(async () => {
      this.deps.gate.begin()
      try {
        await this.drainAgents()
      } finally {
        this.deps.gate.end()
      }
    })
  }

  setLoginShare(enabled: boolean): Promise<{ settings: PublicSettings; status: LoginShareStatus }> {
    return this.enqueue(async () => {
      const hostId = this.deps.settings.workspaceHost
      if (hostId === 'local') throw new Error('Login sharing applies to SSH workspaces.')
      const host = await this.deps.registry.connect(hostId)
      this.deps.gate.begin()
      let result = {
        settings: this.deps.settings.publicSettings(),
        status: this.deps.loginShare.status(hostId)
      }
      try {
        await this.drainAgents()
        this.deps.settings.setShareLogins(hostId, enabled)
        if (enabled) {
          await this.deps.loginShare.prelude(host)
          const status = this.deps.loginShare.status(hostId)
          if (status.error) throw new Error(status.error)
        } else {
          await this.deps.loginShare.detach(host as SshHost)
        }
        result = {
          settings: this.deps.settings.publicSettings(),
          status: this.deps.loginShare.status(hostId)
        }
      } finally {
        this.deps.gate.end()
      }
      void this.deps.omp.refresh()
      return result
    })
  }

  private async transition(ref: WorkspaceRef): Promise<PublicSettings> {
    const host = await this.deps.registry.connect(typeof ref?.host === 'string' ? ref.host : 'local')
    const path = await expandPath(host, typeof ref?.path === 'string' ? ref.path : '')
    const info = await host.stat(path)
    if (!info?.isDirectory) throw new Error(`Folder not found on ${host.id}: ${path}`)
    const resolved = await host.realpath(path)

    if (host.id === this.deps.settings.workspaceHost && resolved === this.deps.settings.workspacePath) {
      return this.deps.settings.publicSettings()
    }

    const token = this.deps.gate.begin()
    let result = this.deps.settings.publicSettings()
    try {
      await this.drainAgents()
      this.deps.settings.setWorkspace({ host: host.id, path: resolved })
      this.deps.plan.resetWatching()
      this.deps.git.resetWatching()
      const goals = await this.deps.plan.listGoals()
      const summary = await this.deps.git.summary()
      if (this.deps.gate.current() === token) {
        this.deps.onGoals(goals)
        this.deps.onGit(summary)
      }
      result = this.deps.settings.publicSettings()
    } finally {
      this.deps.gate.end()
    }
    void this.deps.omp.refresh()
    return result
  }

  private async drainAgents(): Promise<void> {
    // Cancel pending approvals before waiting on the loop, so an approval-blocked
    // run can observe its abort instead of holding the transition open.
    const errors: unknown[] = []
    const step = async (run: () => void | Promise<void>): Promise<void> => {
      try {
        await run()
      } catch (error) {
        errors.push(error)
      }
    }
    await step(() => this.deps.broker.cancelAll())
    await step(() => this.deps.loop.drain())
    await step(() => this.deps.consult.dispose())
    await step(() => this.deps.sessions.dispose())
    await step(() => this.deps.terminal.dispose())
    if (errors.length) throw errors[0]
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
