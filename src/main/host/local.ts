import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFile, mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, posix } from 'node:path'
import { shellEnv } from '../omp/env'
import {
  assertMaxBytes,
  collect,
  spawnPiped,
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type SpawnSpec,
  type StatInfo,
  type TerminalLaunch,
  type WorkspaceHost
} from './host'

export class LocalHost implements WorkspaceHost {
  readonly kind = 'local' as const
  readonly id = 'local'
  readonly path = posix
  readonly pollMs = { plan: 2_000, git: 2_500 }

  private loginEnv(): Promise<NodeJS.ProcessEnv> {
    return shellEnv()
  }

  home(): Promise<string> {
    return Promise.resolve(homedir())
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const env = { ...(await this.loginEnv()), ...(options.env || {}) }
    const child = spawnPiped(command, args, { cwd: options.cwd, env })
    return collect(child, { input: options.input, timeoutMs: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer })
  }

  async readFile(path: string, maxBytes?: number): Promise<Buffer> {
    assertMaxBytes(maxBytes)
    if (maxBytes === undefined) return readFile(path)
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  }

  realpath(path: string): Promise<string> {
    return realpath(path)
  }

  async spawn(spec: SpawnSpec): Promise<ChildProcessWithoutNullStreams> {
    const env = { ...(await this.loginEnv()), ...(spec.env || {}) }
    return spawnPiped(spec.command, spec.args, { cwd: spec.cwd, env })
  }

  async terminal(cwd: string, shell: string): Promise<TerminalLaunch> {
    const info = await this.stat(cwd)
    if (!info?.isDirectory) throw new Error('Terminal working directory does not exist.')
    return {
      command: shell,
      ptyArgs: ['-l'],
      pipeArgs: ['-i'],
      cwd,
      env: {
        ...(await this.loginEnv()),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PROHARNESS_TERMINAL: '1'
      },
      shell
    }
  }
}
