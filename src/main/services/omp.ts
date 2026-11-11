import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import type { ModelInfo, OmpStatus } from '@shared/types'
import type { WorkspaceHost } from '../host/host'
import type { OmpSpawn } from '../omp/agent'
import { findOmp, ompVersion } from '../omp/env'
import { OmpRpc } from '../omp/rpc'
import { PLAN_TOOL_NAMES } from './host-tools'

type Json = Record<string, unknown>

const PROBE_ARGS = ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--tools', 'read']

function overlayYaml(): string {
  return ['tools:', '  approval:', ...PLAN_TOOL_NAMES.map((name) => `    ${name}: allow`), ''].join('\n')
}

function modelFromJson(raw: Json): ModelInfo | null {
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

interface OmpTarget {
  host: WorkspaceHost
  cwd: string
}

/**
 * Locates omp, captures the login-shell environment, and caches the model
 * catalog omp reports for the user's configured providers. Every operation
 * runs on the active workspace host.
 */
export class OmpService {
  private status: OmpStatus
  private refreshing: Promise<OmpStatus> | null = null
  private refreshingKey: string | null = null
  private readonly binaries = new Map<string, { path: string; explicit: string }>()
  private readonly overlays = new Map<string, Promise<string>>()
  private listeners = new Set<(status: OmpStatus) => void>()

  constructor(
    private readonly explicitPath: () => string,
    private readonly cwd: () => string,
    private readonly cacheFile: string,
    private readonly activeHost: () => WorkspaceHost,
    /** Attaches login sharing for a host and returns the prelude to run before omp. */
    private readonly loginPrelude: (host: WorkspaceHost) => Promise<string> = async () => ''
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

  /** Resolves the omp binary on `host` or throws an actionable error. */
  async binary(host: WorkspaceHost = this.activeHost()): Promise<string> {
    const explicit = this.explicitPath()
    const cached = this.binaries.get(host.id)
    if (cached && cached.explicit === explicit) return cached.path
    const path = await findOmp(host, host.kind === 'local' ? explicit : '')
    if (!path) {
      if (host.kind === 'local' && explicit) {
        throw new Error(`omp was not found at ${explicit}. Fix the path in Settings.`)
      }
      if (host.kind === 'local') {
        throw new Error(
          'omp (Oh My Pi) was not found on PATH. Install it from https://omp.sh or set its path in Settings.'
        )
      }
      throw new Error(
        `omp is not installed on ${host.id}. Install it there with: curl -fsSL https://omp.sh/install | sh`
      )
    }
    this.binaries.set(host.id, { path, explicit })
    return path
  }

  /** The overlay omp reads on `host`; written once per host per service instance. */
  overlayFor(host: WorkspaceHost): Promise<string> {
    const cached = this.overlays.get(host.id)
    if (cached) return cached
    const write = this.writeOverlay(host).catch((error) => {
      this.overlays.delete(host.id)
      throw error
    })
    this.overlays.set(host.id, write)
    return write
  }

  private async writeOverlay(host: WorkspaceHost): Promise<string> {
    const file =
      host.kind === 'local'
        ? join(dirname(this.cacheFile), 'omp-overlay.yml')
        : posix.join(await host.home(), '.cache', 'proharness', 'omp-overlay.yml')
    await host.writeText(file, overlayYaml())
    return file
  }

  /** Resolves the binary, then starts omp with `args` and a freshly attached prelude. */
  async spawner(host: WorkspaceHost = this.activeHost(), cwd: string = this.cwd()): Promise<OmpSpawn> {
    const path = await this.binary(host)
    return async (args) => {
      const prelude = await this.loginPrelude(host)
      try {
        return await host.spawn({ command: path, args, cwd, env: { PI_RPC_EMIT_TITLE: '0' }, prelude })
      } catch (error) {
        throw new Error(`Could not start omp at "${path}" on ${host.id}: ${(error as Error).message}`)
      }
    }
  }

  refresh(): Promise<OmpStatus> {
    const target: OmpTarget = { host: this.activeHost(), cwd: this.cwd() }
    const hostId = target.host.id
    const targetKey = `${hostId}\u0000${target.cwd}`
    if (this.refreshing && this.refreshingKey === targetKey) return this.refreshing
    const previous = this.refreshing
    const run = (previous ? previous.catch(() => this.status) : Promise.resolve(this.status))
      .then(() => this.load(target))
      .catch((error) => {
        const base =
          this.status.hostId === hostId ? this.status : this.readCache(this.cachePath(hostId), hostId)
        return this.publish({ ...base, hostId, ok: false, error: (error as Error).message, checkedAt: Date.now() })
      })
    this.refreshing = run
    this.refreshingKey = targetKey
    void run.finally(() => {
      if (this.refreshing !== run) return
      this.refreshing = null
      this.refreshingKey = null
    })
    return run
  }

  private async load(target: OmpTarget): Promise<OmpStatus> {
    const { host, cwd } = target
    const local = host.kind === 'local'
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
    const version = await ompVersion(host, path)
    const displayPath = local ? path : `${host.id}:${path}`
    if (!(await host.stat(cwd))?.isDirectory) {
      return this.publish({
        ...base,
        ok: false,
        path: displayPath,
        version,
        error: `Workspace folder "${cwd}" is missing or not a directory on ${host.id}. Choose another workspace in Settings.`,
        checkedAt: Date.now()
      })
    }
    let rpc: OmpRpc | null = null
    try {
      const spawn = await this.spawner(host, cwd)
      rpc = new OmpRpc({ spawnChild: () => spawn(PROBE_ARGS) })
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
      if (rpc) await rpc.close(2_000).catch((error) => console.error('Closing the omp probe failed:', error))
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
