import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelInfo, OmpStatus } from '@shared/types'
import type { WorkspaceHost } from '../host/host'
import { findOmp, ompVersion, shellEnv } from '../omp/env'
import { OmpRpc } from '../omp/rpc'

type Json = Record<string, unknown>

const PROBE_ARGS = ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--tools', 'read']

export function modelFromJson(raw: Json): ModelInfo | null {
  if (typeof raw.provider !== 'string' || typeof raw.id !== 'string') return null
  const cost = (raw.cost || {}) as Json
  const thinking = (raw.thinking || {}) as Json
  return {
    key: `${raw.provider}/${raw.id}`,
    provider: raw.provider,
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : null,
    reasoning: Boolean(raw.reasoning),
    efforts: Array.isArray(thinking.efforts) ? (thinking.efforts as unknown[]).map(String) : [],
    costIn: typeof cost.input === 'number' ? cost.input : null,
    costOut: typeof cost.output === 'number' ? cost.output : null
  }
}

function parseVersion(output: string): string | null {
  const match = output.match(/omp\/([\w.+-]+)/) || output.match(/(\d+\.\d+\.\d+[\w.+-]*)/)
  return match ? match[1] : output.trim().slice(0, 40) || null
}

/**
 * Locates omp, captures the login-shell environment, and caches the model
 * catalog omp reports for the user's configured providers. Every operation
 * runs on the active workspace host.
 */
export class OmpService {
  private status: OmpStatus
  private refreshing: Promise<OmpStatus> | null = null
  private refreshingHost: string | null = null
  private readonly binaries = new Map<string, string>()
  private listeners = new Set<(status: OmpStatus) => void>()
  /** Runs before any omp process is spawned on a host (e.g. attach login sharing). */
  prepareHost: (host: WorkspaceHost) => Promise<void> = async () => undefined

  constructor(
    private readonly explicitPath: () => string,
    private readonly cwd: () => string,
    private readonly cacheFile: string,
    private readonly activeHost: () => WorkspaceHost
  ) {
    const hostId = activeHost().id
    this.status = this.readCache(this.cachePath(hostId), hostId)
  }

  private cachePath(hostId: string): string {
    if (hostId === 'local') return this.cacheFile
    return this.cacheFile.replace(/\.json$/, `-${hostId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }

  private readCache(file: string, hostId: string): OmpStatus {
    try {
      if (existsSync(file)) {
        const cached = JSON.parse(readFileSync(file, 'utf8')) as OmpStatus
        if (Array.isArray(cached.models)) return { ...cached, hostId, ok: false, error: null }
      }
    } catch {
      // Rebuild below.
    }
    return { hostId, ok: false, path: null, version: null, error: null, defaultModel: null, models: [], checkedAt: 0 }
  }

  private writeCache(file: string, status: OmpStatus): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(status), 'utf8')
    } catch {
      // Cache is an optimization only.
    }
  }

  onChange(listener: (status: OmpStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  current(): OmpStatus {
    return this.status
  }

  env(): Promise<NodeJS.ProcessEnv> {
    return shellEnv()
  }

  /** Resolves the omp binary on `host` or throws an actionable error. */
  async binary(host: WorkspaceHost = this.activeHost()): Promise<string> {
    if (host.kind !== 'local') await this.prepareHost(host)
    if (host.kind === 'local') {
      const env = await shellEnv()
      const path = findOmp(this.explicitPath(), env)
      if (!path) {
        throw new Error(
          this.explicitPath()
            ? `omp was not found at ${this.explicitPath()}. Fix the path in Settings.`
            : 'omp (Oh My Pi) was not found on PATH. Install it from https://omp.sh or set its path in Settings.'
        )
      }
      return path
    }
    const cached = this.binaries.get(host.id)
    if (cached) return cached
    const result = await host.exec('sh', [
      '-c',
      'command -v omp || ls ~/.local/bin/omp ~/.bun/bin/omp 2>/dev/null | head -1'
    ])
    const path = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
    if (!path) {
      throw new Error(
        `omp is not installed on ${host.id}. Install it there with: curl -fsSL https://omp.sh/install | sh`
      )
    }
    this.binaries.set(host.id, path)
    return path
  }

  refresh(): Promise<OmpStatus> {
    const hostId = this.activeHost().id
    if (this.refreshing && this.refreshingHost === hostId) return this.refreshing
    const previous = this.refreshing
    const run = (previous ? previous.catch(() => this.status) : Promise.resolve(this.status))
      .then(() => this.load())
      .catch((error) =>
        this.publish({ ...this.status, hostId, ok: false, error: (error as Error).message, checkedAt: Date.now() })
      )
    this.refreshing = run
    this.refreshingHost = hostId
    void run.finally(() => {
      if (this.refreshing !== run) return
      this.refreshing = null
      this.refreshingHost = null
    })
    return run
  }

  private async load(): Promise<OmpStatus> {
    const host = this.activeHost()
    const local = host.kind === 'local'
    const env = local ? await shellEnv() : {}
    const base: OmpStatus =
      this.status.hostId === host.id ? this.status : this.readCache(this.cachePath(host.id), host.id)
    // Show the host's last known catalog right away; the probe below refreshes it.
    if (this.status.hostId !== host.id) this.publish({ ...base, ok: false, error: null })
    let path: string
    try {
      path = await this.binary(host)
    } catch (error) {
      return this.publish({ ...base, ok: false, path: null, error: (error as Error).message, checkedAt: Date.now() })
    }
    let version: string | null
    if (local) {
      version = await ompVersion(path, env)
    } else {
      const result = await host.exec(path, ['--version'], { timeoutMs: 20_000 }).catch(() => null)
      version = result && result.code === 0 ? parseVersion(result.stdout) : null
    }
    const displayPath = local ? path : `${host.id}:${path}`
    const cwd = local && !existsSync(this.cwd()) ? process.cwd() : this.cwd()
    const rpc = new OmpRpc({
      command: path,
      args: PROBE_ARGS,
      cwd,
      env,
      ...(local ? {} : { spawnChild: () => host.spawn({ command: path, args: PROBE_ARGS, cwd, env: {} }) })
    })
    try {
      await rpc.start(90_000)
      const [models, state] = await Promise.all([
        rpc.request<Json>({ type: 'get_available_models' }, 90_000),
        rpc.request<Json>({ type: 'get_state' }, 30_000)
      ])
      const list = (Array.isArray(models?.models) ? models.models : Array.isArray(models) ? models : []) as Json[]
      const parsed = list.map(modelFromJson).filter((item): item is ModelInfo => item !== null)
      const current = state?.model as Json | undefined
      const status: OmpStatus = {
        hostId: host.id,
        ok: true,
        path: displayPath,
        version,
        error: null,
        defaultModel: current ? `${current.provider}/${current.id}` : null,
        models: parsed,
        checkedAt: Date.now()
      }
      this.writeCache(this.cachePath(host.id), status)
      return this.publish(status)
    } catch (error) {
      return this.publish({
        ...base,
        ok: false,
        path: displayPath,
        version,
        error: `omp is installed but did not start: ${(error as Error).message}`,
        checkedAt: Date.now()
      })
    } finally {
      await rpc.close(2_000)
    }
  }

  private publish(status: OmpStatus): OmpStatus {
    // Stamp the host so a catalog is never applied to another host's settings.
    status = { ...status, hostId: status.hostId || this.activeHost().id }
    if (status.hostId !== this.activeHost().id) return status
    this.status = status
    for (const listener of this.listeners) listener(status)
    return status
  }
}
