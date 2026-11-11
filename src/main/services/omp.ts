import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelInfo, OmpStatus } from '@shared/types'
import { findOmp, ompVersion, shellEnv } from '../omp/env'
import { OmpRpc } from '../omp/rpc'

type Json = Record<string, unknown>

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

/**
 * Locates omp, captures the login-shell environment, and caches the model
 * catalog omp reports for the user's configured providers.
 */
export class OmpService {
  private status: OmpStatus
  private refreshing: Promise<OmpStatus> | null = null
  private listeners = new Set<(status: OmpStatus) => void>()

  constructor(
    private readonly explicitPath: () => string,
    private readonly cwd: () => string,
    private readonly cacheFile: string
  ) {
    this.status = this.readCache()
  }

  private readCache(): OmpStatus {
    try {
      if (existsSync(this.cacheFile)) {
        const cached = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as OmpStatus
        if (Array.isArray(cached.models)) return { ...cached, ok: false, error: null }
      }
    } catch {
      // Rebuild below.
    }
    return { ok: false, path: null, version: null, error: null, defaultModel: null, models: [], checkedAt: 0 }
  }

  private writeCache(status: OmpStatus): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      writeFileSync(this.cacheFile, JSON.stringify(status), 'utf8')
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

  /** Resolves the omp binary or throws an actionable error. */
  async binary(): Promise<string> {
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

  refresh(): Promise<OmpStatus> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.load().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async load(): Promise<OmpStatus> {
    const env = await shellEnv()
    let path: string
    try {
      path = await this.binary()
    } catch (error) {
      return this.publish({ ...this.status, ok: false, path: null, error: (error as Error).message, checkedAt: Date.now() })
    }
    const version = await ompVersion(path, env)
    const rpc = new OmpRpc({
      command: path,
      args: ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--tools', 'read'],
      cwd: existsSync(this.cwd()) ? this.cwd() : process.cwd(),
      env
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
        ok: true,
        path,
        version,
        error: null,
        defaultModel: current ? `${current.provider}/${current.id}` : null,
        models: parsed,
        checkedAt: Date.now()
      }
      this.writeCache(status)
      return this.publish(status)
    } catch (error) {
      return this.publish({
        ...this.status,
        ok: false,
        path,
        version,
        error: `omp is installed but did not start: ${(error as Error).message}`,
        checkedAt: Date.now()
      })
    } finally {
      await rpc.close(2_000)
    }
  }

  private publish(status: OmpStatus): OmpStatus {
    this.status = status
    for (const listener of this.listeners) listener(status)
    return status
  }
}
