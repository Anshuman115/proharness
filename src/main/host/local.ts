import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { shellEnv } from '../omp/env'
import { collect, spawnPiped, type DirEntry, type ExecOptions, type ExecResult, type SpawnSpec, type StatInfo, type WorkspaceHost } from './host'

export class LocalHost implements WorkspaceHost {
  readonly kind = 'local' as const
  readonly id = 'local'
  readonly path = posix

  async env(): Promise<NodeJS.ProcessEnv> {
    return shellEnv()
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const env = { ...(await this.env()), ...(options.env || {}) }
    const child = spawnPiped(command, args, { cwd: options.cwd, env })
    return collect(child, { input: options.input, timeoutMs: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer })
  }

  readFile(path: string): Promise<Buffer> {
    return readFile(path)
  }

  readText(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  async writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.ph-${process.pid}-${Date.now()}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  }

  async appendText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, content, 'utf8')
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  async stat(path: string): Promise<StatInfo | null> {
    try {
      const info = await stat(path)
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return null
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  }

  realpath(path: string): Promise<string> {
    return realpath(path)
  }

  spawn(spec: SpawnSpec): ChildProcessWithoutNullStreams {
    return spawnPiped(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...(spec.env || {}) } })
  }

  dispose(): void {
    // Nothing held open.
  }
}
